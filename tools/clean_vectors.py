# -*- coding: utf-8 -*-
"""清掉向量库里的陈旧块，只留本次 ingest 出来的那批。

Vectorize 没有按前缀删的接口，也没法从库里读出每个块的正文来判断归属，
所以做法是：把库里全部 id 列出来，跟本地重新算一遍的 id 集合比对，
差集就是要删的。

用法：
    python tools/clean_vectors.py --dry    # 只报告，不删
    python tools/clean_vectors.py          # 真删
"""
import io
import json
import os
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# ingest 模块自己会包装 stdout，这里别再包一次——会把已关的流再包一遍
from ingest import chunk_text, load_articles, load_env  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX = 'blog-content'


def api(env, path):
    return (f"https://api.cloudflare.com/client/v4/accounts/"
            f"{env['CF_ACCOUNT_ID']}{path}")


def hdr(env):
    return {'Authorization': f"Bearer {env['VECTORIZE_API_TOKEN']}"}


def list_all_ids(env):
    """GET /list 分页拿全部 id。"""
    ids, cursor, page = [], None, 0
    while page < 60:
        url = api(env, f'/vectorize/v2/indexes/{INDEX}/list?count=100')
        if cursor:
            url += '&cursor=' + urllib.request.quote(cursor, safe='')
        req = urllib.request.Request(url, headers=hdr(env))
        d = json.loads(urllib.request.urlopen(req, timeout=120).read().decode())
        res = d['result']
        batch = res.get('vectors') or []
        ids += [v if isinstance(v, str) else v['id'] for v in batch]
        cursor = res.get('nextCursor')
        page += 1
        if not res.get('isTruncated') or not cursor:
            break
    return ids


def expected_ids():
    """本地重算一遍应该有哪些 id —— 跟 ingest 的口径完全一致。"""
    out = set()
    for a in load_articles():
        for i, _ in chunk_text(a['body'], a['title']):
            out.add(f"{a['id']}#{i}")
    return out


def main():
    env = load_env()
    if not env.get('VECTORIZE_API_TOKEN'):
        print('缺 VECTORIZE_API_TOKEN，看 .env.local')
        return 1

    print('拉取库里全部 id …')
    have = list_all_ids(env)
    want = expected_ids()

    have_set = set(have)
    stale = sorted(have_set - want)
    missing = sorted(want - have_set)

    print(f'库里 {len(have_set)} 个（列表拉了 {len(have)} 条，可能有重复）')
    print(f'本地算出应该 {len(want)} 个')
    print(f'陈旧、要删：{len(stale)} 个')
    print(f'缺失、要补：{len(missing)} 个')

    if stale:
        print('\n陈旧 id（按文章归组）：')
        groups = {}
        for i in stale:
            groups.setdefault(i.split('#')[0], []).append(i.split('#')[1])
        for k, v in sorted(groups.items()):
            print(f'  {k:<34} {len(v):>3} 块  #{", ".join(sorted(v, key=int)[:12])}')

    if missing:
        print('\n缺失 id：', missing[:20])

    if '--dry' in sys.argv:
        print('\n（dry run，没删）')
        return 0

    if not stale:
        print('\n没有陈旧的，不用动。')
        return 0

    # delete_by_ids 有单次上限，分批
    BATCH = 100
    total = 0
    for s in range(0, len(stale), BATCH):
        batch = stale[s:s + BATCH]
        body = json.dumps({'ids': batch}).encode()
        req = urllib.request.Request(
            api(env, f'/vectorize/v2/indexes/{INDEX}/delete_by_ids'),
            data=body, method='POST',
            headers={**hdr(env), 'Content-Type': 'application/json'})
        d = json.loads(urllib.request.urlopen(req, timeout=180).read().decode())
        if not d.get('success'):
            print('删除失败:', d.get('errors'))
            return 1
        total += len(batch)
        print(f'  删了 {len(batch)} 个')

    print(f'\n共删除 {total} 个陈旧块。')
    print('再跑一次 --dry 确认库干净。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
