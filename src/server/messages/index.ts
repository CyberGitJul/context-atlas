import { app } from './app.js';
import { edit } from './edit.js';
import { hints } from './hints.js';
import { provider } from './provider.js';

/** The one place for the texts the server shows in the interface, one file per area. */
export const msg = { hints, provider, edit, app };
