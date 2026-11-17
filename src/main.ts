import './style.css';
import { App } from './client/app';

const app = new App();
// Handy for poking at the game from the browser console while developing.
if (import.meta.env.DEV) (window as unknown as { __app: App }).__app = app;
