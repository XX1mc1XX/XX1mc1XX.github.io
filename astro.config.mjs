// @ts-check
import { defineConfig } from 'astro/config';

import preact from '@astrojs/preact';
import rehypeImages from './src/utils/rehype-images.mjs';

// https://astro.build/config
export default defineConfig({
  // 站点地址。RSS、sitemap 里的绝对链接要用它。买了域名后改成自己的
  site: 'https://xx1mc1xx.pages.dev',

  markdown: {
      // dark-plus / light-plus 就是 VS Code 自带的两套主题，
      // 代码块配色与编辑器里看到的完全一致
      shikiConfig: {
          themes: { light: 'light-plus', dark: 'dark-plus' },
      },
      // 给正文里的图补上宽高和 loading="lazy"，理由见该文件的注释
      rehypePlugins: [rehypeImages],
	},

  integrations: [preact()],
});