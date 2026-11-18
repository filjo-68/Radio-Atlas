import { messages } from './translations.js';

export const languages = [
  ['en', 'English'], ['bg', 'Български'], ['es', 'Español'],
  ['fr', 'Français'], ['pt', 'Português'], ['zh-Hans', '简体中文'], ['hi', 'हिन्दी'],
  ['nb', 'Norsk bokmål'], ['de', 'Deutsch'], ['uk', 'Українська']
];

const key = 'radio-atlas:language';
let language = 'en';
try {
  const stored = localStorage.getItem(key);
  if (languages.some(([code]) => code === stored)) language = stored;
} catch { /* Use the default when storage is unavailable. */ }

export function getLanguage() { return language; }

export function setLanguage(code) {
  if (!languages.some(([supported]) => supported === code)) return false;
  language = code;
  try { localStorage.setItem(key, code); } catch { /* Apply for the current session. */ }
  return true;
}

export function t(id, values = {}) {
  const template = messages[language]?.[id] ?? messages.en[id] ?? id;
  return template.replace(/\{(\w+)\}/g, (token, name) => Object.hasOwn(values, name) ? String(values[name]) : token);
}

export function translatePage(values) {
  document.documentElement.lang = language;
  document.title = t('appName');
  for (const node of document.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n, values);
  }
  for (const [selector, attribute, dataKey] of [
    ['[data-i18n-label]', 'aria-label', 'i18nLabel'],
    ['[data-i18n-title]', 'title', 'i18nTitle'],
    ['[data-i18n-placeholder]', 'placeholder', 'i18nPlaceholder'],
    ['[data-i18n-content]', 'content', 'i18nContent']
  ]) {
    for (const node of document.querySelectorAll(selector)) {
      node.setAttribute(attribute, t(node.dataset[dataKey], values));
    }
  }
}
