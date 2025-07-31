import VoidApp from './core/VoidApp.js';
import './bootstrap/error-traps.js';


const Void = new VoidApp(process.env.VOID_TOKEN);
Void.Start();
