// The public website's data is cached for a few seconds; anything that changes it clears the cache.
export const siteCache = new Map();
export const clearSiteCache = (guildId) => siteCache.delete(guildId);
