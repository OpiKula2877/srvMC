import { useSyncExternalStore } from 'react';

export type Route = { page: 'overview' } | { page: 'new' } | { page: 'server'; id: string; tab: string; file?: string };

export function parseRoute(hash: string): Route {
  const [pathPart = '', query = ''] = hash.replace(/^#\/?/, '').split('?');
  const parts = pathPart.split('/').filter(Boolean);
  if (parts[0] === 'new') return { page: 'new' };
  if (parts[0] === 'server' && parts[1]) {
    const file = new URLSearchParams(query).get('file') ?? undefined;
    return { page: 'server', id: parts[1], tab: parts[2] ?? 'konzole', file };
  }
  return { page: 'overview' };
}

export function href(route: Route): string {
  if (route.page === 'new') return '#/new';
  if (route.page === 'server') {
    const base = `#/server/${route.id}${route.tab === 'konzole' ? '' : `/${route.tab}`}`;
    return route.file ? `${base}?file=${encodeURIComponent(route.file)}` : base;
  }
  return '#/';
}

export function navigate(route: Route): void {
  location.hash = href(route);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(
    (cb) => {
      window.addEventListener('hashchange', cb);
      return () => window.removeEventListener('hashchange', cb);
    },
    () => location.hash,
  );
  return parseRoute(hash);
}
