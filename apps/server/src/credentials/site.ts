// A site is a registrable domain (example.com, x.com, apple.com), computed by
// the server from whatever the owner or the AI wrote (a URL, a host name or the domain itself),
// with the public suffix list, its private section included: on a shared host (myshopify.com,
// vercel.app, pages.dev, ...) each tenant's name is a site of its own (myshop.myshopify.com),
// never the hoster's domain, which another party's pages share. Nothing here knows any site.
import { getDomain } from "tldts";

/** The registrable domain of a URL, host name or domain, lower case; null when there is none
 * (an IP address, localhost, a bare public suffix, something that is not a name). */
export function siteOf(input: string): string | null {
  const text = input.trim().toLowerCase();
  if (!text || text.length > 2048 || /\s/.test(text)) return null;
  const domain = getDomain(text, { allowPrivateDomains: true });
  return domain && /^[a-z0-9.-]+$/.test(domain) ? domain : null;
}

/** Whether a host (or URL) belongs to `site`: it is the site or one of its subdomains. */
export function onSite(host: string, site: string) {
  return siteOf(host) === site;
}
