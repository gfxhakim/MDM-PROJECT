// Which connectors besides the MDM platform are switched on. For now the client wants only MDM
// (webhook + API key). WhatsApp Business, Yeastar and the Zoho import stay in the code, tested,
// and come back by listing them in OPTIONAL_INTEGRATIONS (e.g. "whatsapp,yeastar,zoho").
// While one is off its routes answer 404, it is not on the Integrations page and it sends nothing.
export const OPTIONAL = ['whatsapp', 'yeastar', 'zoho'];

export function optionalOn(name) {
  return String(process.env.OPTIONAL_INTEGRATIONS || '').toLowerCase().split(/[\s,]+/).includes(name);
}
