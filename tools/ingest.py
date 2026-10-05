# -*- coding: utf-8 -*-
"""把构建产物里的文章切块灌进 Cloudflare Vectorize。

走 Cloudflare REST 直连，不经 Worker 的 /api/ingest —— 那条路要多一个
INGEST_TOKEN，而且 Pages 项目的 secret 用 API 读不出值。这里直接用长期
Token（读 token 放进 .env.local），还能顺便查库状态。

正文来源：/articles.json 现在只剩目录（标题+摘要），正文一篇一个文件放在
dist/articles/<id>.json。目录和正文分开是为了页内助手——访客不用为了点开
助手就把全站正文下载一遍。切块口径不变。

切块口径：按空行分段，再把相邻小段合并到接近 CHUNK_CHARS。中文按字符算就行。

进度记在 tools/.ingest_state.json（内容指纹），所以中途断掉再跑会自动跳过
已灌成功的篇目；内容改过的会自动重灌。要强制全部重来加 --force。

用法（blog 目录下）：
    python tools/ingest.py                 # 灌全部（跳过已是最新的）
    python tools/ingest.py <slug> [...]    # 只灌指定几篇
    python tools/ingest.py --force         # 忽略进度，全部重灌
    python tools/ingest.py --list          # 只看库里有什么，不写
    python tools/ingest.py --count         # 查库里有多少向量
"""
import hashlib
import io
import json
import os
import sys
import urllib.error
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHUNK_CHARS = 900
MIN_CHUNK_CHARS = 200
EMBED_MODEL = '@cf/baai/bge-m3'
INDEX = 'blog-content'
EMBED_BATCH = 10  # bge-m3 单次能吃的条数有限

# 正常一次请求只要 2-20 秒。原来设 180/300 秒，碰上被掐断的连接就得干等三分钟，
# 而重试又从头来——慢的其实是这个等待，不是 Cloudflare
EMBED_TIMEOUT = 60
UPSERT_TIMEOUT = 90

# 记哪些文章已经灌完（含内容指纹）。网络一抖就得重跑时，靠它跳过已完成的部分，
# 不然每次中断都从第 1 篇重来
STATE_PATH = os.path.join(ROOT, 'tools', '.ingest_state.json')


def load_env():
    """读 .env.local（不进仓库）。"""
    path = os.path.join(ROOT, '.env.local')
    env = {}
    if os.path.exists(path):
        for line in io.open(path, encoding='utf-8'):
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            env[k.strip()] = v.strip()
    return env


def api(env, path):
    return (f"https://api.cloudflare.com/client/v4/accounts/"
            f"{env['CF_ACCOUNT_ID']}{path}")


def headers(env, ctype='application/json; charset=utf-8'):
    return {'Content-Type': ctype,
            'Authorization': f"Bearer {env['VECTORIZE_API_TOKEN']}"}


def read_state():
    """读断点状态：{slug: {'hash': 内容指纹, 'chunks': 块数}}"""
    try:
        return json.loads(io.open(STATE_PATH, encoding='utf-8').read())
    except Exception:
        return {}


def write_state(state):
    try:
        io.open(STATE_PATH, 'w', encoding='utf-8').write(
            json.dumps(state, ensure_ascii=False, indent=1, sort_keys=True))
    except Exception:
        pass  # 记不住就下次重灌，不影响正确性


def body_hash(text):
    return hashlib.sha1(text.encode('utf-8')).hexdigest()[:16]


def load_articles():
    """读构建产物，返回 [{id, title, url, body}, ...]。

    目录（dist/articles.json）和正文（dist/articles/<id>.json）是分开的两份，
    这里合回一份。clean_vectors.py 也走这个函数，保证两边口径完全一致。
    """
    index_path = os.path.join(ROOT, 'dist', 'articles.json')
    if not os.path.exists(index_path):
        raise SystemExit(f'找不到 {index_path}，先跑一次 npm run build')

    index = json.loads(io.open(index_path, encoding='utf-8').read())

    out = []
    for meta in index:
        single = os.path.join(ROOT, 'dist', 'articles', f"{meta['id']}.json")
        if not os.path.exists(single):
            raise SystemExit(f'找不到 {single}，构建产物不完整，重新跑一次 npm run build')
        out.append(json.loads(io.open(single, encoding='utf-8').read()))
    return out


def chunk_text(body, title):
    """按空行切段并合并。返回 [(序号, 文本)]。

    行尾先统一成 LF：草稿在 Windows 上是 CRLF，正文到这儿可能是 \\r\\n\\r\\n，
    而切段只认 \\n\\n —— 不归一化的话整篇会被当成一段（块数变成 1），
    单块还会撑爆 embed 的输入长度限制。
    """
    body = body.replace('\r\n', '\n').replace('\r', '\n')
    paras = [p.strip() for p in body.split('\n\n') if p.strip()]

    chunks, buf = [], ''
    for p in paras:
        # 单段就超长（比如一大张代码块或表格），按上限硬切
        if len(p) >= CHUNK_CHARS:
            if buf:
                chunks.append(buf)
                buf = ''
            chunks.extend(p[i:i + CHUNK_CHARS] for i in range(0, len(p), CHUNK_CHARS))
            continue
        if buf and len(buf) + len(p) + 2 > CHUNK_CHARS:
            chunks.append(buf)
            buf = p
        else:
            buf = f'{buf}\n\n{p}' if buf else p

    if buf:
        # 尾巴太短就并进上一块，免得出现孤零零一段
        if chunks and len(buf) < MIN_CHUNK_CHARS:
            chunks[-1] = f'{chunks[-1]}\n\n{buf}'
        else:
            chunks.append(buf)

    return list(enumerate(chunks))


def embed(env, texts):
    """一批文本 → 一批向量。"""
    req = urllib.request.Request(
        api(env, f'/ai/run/{EMBED_MODEL}'),
        data=json.dumps({'text': texts}).encode('utf-8'),
        method='POST', headers=headers(env))
    res = json.loads(urllib.request.urlopen(req, timeout=EMBED_TIMEOUT).read().decode('utf-8'))
    if not res.get('success'):
        raise RuntimeError(f"embed 失败: {res.get('errors')}")
    return res['result']['data']


def upsert(env, vectors):
    """Vectorize 的 upsert 收 NDJSON，不是 JSON 数组。"""
    body = '\n'.join(json.dumps(v, ensure_ascii=False) for v in vectors)
    req = urllib.request.Request(
        api(env, f'/vectorize/v2/indexes/{INDEX}/upsert'),
        data=body.encode('utf-8'),
        method='POST',
        headers=headers(env, 'application/x-ndjson; charset=utf-8'))
    res = json.loads(urllib.request.urlopen(req, timeout=UPSERT_TIMEOUT).read().decode('utf-8'))
    if not res.get('success'):
        raise RuntimeError(f"upsert 失败: {res.get('errors')}")
    return res['result']


def index_info(env):
    req = urllib.request.Request(
        api(env, f'/vectorize/v2/indexes/{INDEX}'),
        headers=headers(env))
    return json.loads(urllib.request.urlopen(req, timeout=60).read().decode('utf-8'))['result']


def main():
    env = load_env()
    if not env.get('VECTORIZE_API_TOKEN') or not env.get('CF_ACCOUNT_ID'):
        print('缺 VECTORIZE_API_TOKEN / CF_ACCOUNT_ID，看看 .env.local')
        return 1

    args = sys.argv[1:]

    if '--count' in args:
        print(json.dumps(index_info(env), ensure_ascii=False, indent=2))
        return 0

    articles = load_articles()
    only = [a for a in args if not a.startswith('--')]
    force = '--force' in args

    state = {} if force else read_state()
    total = 0
    skipped = 0
    failed = []

    for art in articles:
        slug = art['id']
        if only and slug not in only:
            continue

        # 内容没变就跳过：网络一抖就得重跑，不记进度的话每次都从第一篇白烧一遍
        digest = body_hash(art['title'] + '\n' + art['body'])
        done = state.get(slug)
        if done and done.get('hash') == digest:
            print(f'{"":>4}    {slug:<34} 已是最新，跳过')
            skipped += 1
            continue

        url = art.get('url') or f'/blog/{slug}/'
        pieces = chunk_text(art['body'], art['title'])

        try:
            vectors = []
            for s in range(0, len(pieces), EMBED_BATCH):
                batch = pieces[s:s + EMBED_BATCH]
                vecs = embed(env, [f'{art["title"]}\n\n{t}' for _, t in batch])
                for (i, _text), v in zip(batch, vecs):
                    vectors.append({
                        'id': f'{slug}#{i}',
                        'values': v,
                        'metadata': {
                            'title': art['title'][:200],
                            'url': url[:300],
                            # metadata 有大小上限，正文截断存即可
                            'text': f'{art["title"]}\n\n{_text}'[:2000],
                        },
                    })

            upsert(env, vectors)
        except Exception as exc:
            # 单篇失败不让整轮到这儿停——记下来，最后一起报，下次跑会自动补
            print(f'{"":>4}    {slug:<34} 失败: {str(exc)[:60]}')
            failed.append(slug)
            continue

        state[slug] = {'hash': digest, 'chunks': len(vectors)}
        write_state(state)
        print(f'{len(vectors):>3} 块  {slug:<34} {art["title"]}')
        total += len(vectors)

    print(f'\n新灌 {total} 块，跳过 {skipped} 篇（已是最新）。')
    if failed:
        print(f'失败 {len(failed)} 篇：{" ".join(failed)}')
        print('再跑一次同一条命令即可，已成功的会自动跳过。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
