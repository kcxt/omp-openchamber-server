// Extension panel entry: the shared settings view, with requests going through
// the extension's local service (see service/src/main.js).
import { connectHost } from '@openchamber/sdk';
import { mountSettings } from './view.js';

const host = connectHost();

const call = async (method, path, body) => {
  const res = await host.serviceRequest({ method, path, ...(body === undefined ? {} : { body }) });
  const data = typeof res.body === 'string' ? JSON.parse(res.body || '{}') : (res.body ?? {});
  if (res.status >= 400) throw new Error(data.error || `request failed (${res.status})`);
  return data;
};

mountSettings({ call });
