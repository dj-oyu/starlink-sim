/** URL of a file under `public/`, honouring Vite's `base` (the app may be served from a sub-path, e.g. GitHub Pages). */
export const assetUrl = (path: string): string => import.meta.env.BASE_URL + path;
