import { createApp } from './app.js';
import { expireElevations } from './auth/elevation.js';

if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is not set. Copy .env.example to .env and set it.');
  process.exit(1);
}

const port = Number(process.env.PORT) || 3000;
createApp().listen(port, () => console.log(`MDM app listening on http://localhost:${port}`));

// Background sweeps. Later steps add the OA holding-queue sweep and the AM rule sweep here.
setInterval(() => expireElevations().catch((e) => console.error('elevation sweep', e)), 60_000);
