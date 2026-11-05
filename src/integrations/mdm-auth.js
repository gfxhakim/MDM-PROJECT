// Sign-in with MDM for staff imported from the platform: the password is checked by MDM itself
// (its Login Regular User endpoint), and the profile MDM returns must be the same platform user
// the account here was imported from. No password is stored here for these accounts unless an
// Admin sets one (then both ways work). Reads only the platform URL; no API key is involved.
import { MdmApiError, platformLogin } from './mdm-api.js';

const url = () => (process.env.MDM_API_URL || 'https://api.mdm.express').replace(/\/$/, '');

/** True when MDM accepts the password for this account's own platform user. */
export async function verifyWithPlatform(user, username, password, { fetchImpl = fetch } = {}) {
  if (!user?.mdmRef || !username || !password) return false;
  try {
    const profile = await platformLogin({ url: url(), fetchImpl }, username, password);
    return profile.trackingId === user.mdmRef;
  } catch (err) {
    if (err instanceof MdmApiError) return false; // wrong password, restricted user, or MDM refused the call
    throw err; // the platform is unreachable: reported, not treated as a wrong password
  }
}
