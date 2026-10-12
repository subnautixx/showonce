import { HttpError } from '../errors.js';

export async function checkedFetch(name, url, init) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new HttpError(502, `Could not reach ${name}: ${err.message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new HttpError(502, `${name} API error ${res.status}: ${body.slice(0, 500)}`);
  }
  return res.json();
}
