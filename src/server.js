import { createApp } from './app.js';
import { expireElevations } from './auth/elevation.js';
import { getLiveConfig } from './config/service.js';
import { runOnboardingSweep } from './oa/rules.js';
import { runAmSweep } from './am/rules.js';
import { mdmConfig, syncSellers } from './integrations/mdm.js';

if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is not set. Copy .env.example to .env and set it.');
  process.exit(1);
}

const port = Number(process.env.PORT) || 3000;
createApp().listen(port, () => console.log(`MDM app listening on http://localhost:${port}`));

// Background sweeps. The onboarding sweep runs every oa.holding_sweep_interval minutes (re-read
// each time, so a published change takes effect without a restart).
setInterval(() => expireElevations().catch((e) => console.error('elevation sweep', e)), 60_000);

async function onboardingLoop() {
  let minutes = 15;
  try {
    minutes = (await getLiveConfig()).values['oa.holding_sweep_interval'];
    await runOnboardingSweep();
  } catch (e) {
    console.error('onboarding sweep', e);
  }
  setTimeout(onboardingLoop, minutes * 60_000);
}
setTimeout(onboardingLoop, 5_000);

// AM: health recompute then rule sweep, nightly at 02:00 UTC (AM 4.6, 5.2).
function scheduleNightly() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 2, 0, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  setTimeout(async () => {
    try {
      const r = await runAmSweep();
      console.log(`AM nightly: ${r.tasksOpened} opened, ${r.tasksUpgraded} upgraded`);
    } catch (e) {
      console.error('AM nightly sweep', e);
    }
    scheduleNightly();
  }, next - now);
}
scheduleNightly();

// MDM platform pull sync, hourly, only when the connector is configured (MDM_SYNC_MINUTES overrides).
if (mdmConfig().url && mdmConfig().apiKey) {
  const every = (Number(process.env.MDM_SYNC_MINUTES) || 60) * 60_000;
  const sync = () => syncSellers().then((s) => console.log(`MDM sync: ${s.updated}/${s.fetched} sellers updated`)).catch((e) => console.error('MDM sync', e.message));
  setTimeout(sync, 10_000);
  setInterval(sync, every);
}
