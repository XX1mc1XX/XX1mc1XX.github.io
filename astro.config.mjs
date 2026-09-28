// @ts-check
import { defineConfig } from 'astro/config';

import preact from '@astrojs/preact';

// https://astro.build/config
export default defineConfig({
  // 站点地址。RSS、sitemap 里的绝对链接要用它
  site: 'https://XX1mc1XX.github.io',

  markdown: {
      // dark-plus / light-plus 就是 VS Code 自带的两套主题，
      // 代码块配色与编辑器里看到的完全一致
      shikiConfig: {
          themes: { light: 'light-plus', dark: 'dark-plus' },
      },
	},

  integrations: [preact()],
});