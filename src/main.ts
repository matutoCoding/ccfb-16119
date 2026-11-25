import './styles.css';
import { startApp } from './app';

const el = document.getElementById('app');
if (!el) throw new Error('#app root missing');
startApp(el);
