/** Normalize the OpenAB target so storage keys stay stable across slash variants. */
export function openABConnectionScope(
  baseUrl: string,
  profileId: string
): string {
  return JSON.stringify([baseUrl.replace(/\/+$/, ""), profileId.trim()])
}

export function openABIdentityStorageKey(
  baseUrl: string,
  profileId: string
): string {
  return `openab_conversation_identities_v1:${openABConnectionScope(
    baseUrl,
    profileId
  )}`
}

export function openABOpenedTabsStorageKey(
  baseUrl: string,
  profileId: string
): string {
  return `openab_opened_tabs:${openABConnectionScope(baseUrl, profileId)}`
}
