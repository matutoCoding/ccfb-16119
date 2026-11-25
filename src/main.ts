import { App } from './ui/app';
import './styles.css';

const el = document.getElementById('app');
if (!el) throw new Error('#app 挂载点缺失');
new App(el).start().catch((err) => {
  el.innerHTML = `<div class="fatal"><h2>启动失败</h2><pre>${(err as Error).message}</pre>
  <p>请使用支持 WebGL2 与浮点纹理的浏览器（Chrome/Edge 90+、Firefox 90+）</p></div>`;
  console.error(err);
});
