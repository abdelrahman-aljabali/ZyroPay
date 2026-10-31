import * as SecureStore from "expo-secure-store";
import Storage from "expo-sqlite/kv-store";
import type { StateStorage } from "zustand/middleware";
import type { SecureKeyValue } from "./session";

/** Keychain (iOS) / Keystore-backed (Android) storage for session tokens. */
export const secureStorage: SecureKeyValue = {
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) =>
    SecureStore.setItemAsync(key, value, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
  deleteItem: (key) => SecureStore.deleteItemAsync(key),
};

/** Non-secret preferences (expo-sqlite/kv-store). */
export const prefsStorage: StateStorage = {
  getItem: (name) => Storage.getItem(name),
  setItem: (name, value) => Storage.setItem(name, value),
  removeItem: (name) => Storage.removeItem(name),
};
