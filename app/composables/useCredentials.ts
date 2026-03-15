import { computed } from 'vue';
import { storageKey } from '../utils/storageKeys';

const LEGACY_UPSTREAM_CREDENTIALS_KEY = 'auth.credentials.v1';

function resolveBrowserOriginBaseUrl() {
  if (typeof window === 'undefined' || !window.location?.origin) return '';
  return window.location.origin.replace(/\/+$/, '');
}

export function clearLegacyUpstreamCredentials() {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.removeItem(storageKey(LEGACY_UPSTREAM_CREDENTIALS_KEY));
  } catch {
    return;
  }
}

export function useManagedConnection() {
  const baseUrl = computed(() => resolveBrowserOriginBaseUrl());

  return {
    baseUrl,
    clearLegacyUpstreamCredentials,
  };
}
