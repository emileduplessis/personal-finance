# Vendored libraries

Served from this site instead of a CDN, so pages load the exact version
reviewed here and no third party sees visitors' requests. To upgrade, fetch
the new build from npm (`npm pack <name>@<version>`), replace the file, rename
it with the new version, and update every `<script src>` and `sw.js`.

| File | Package | License |
|---|---|---|
| `supabase-2.117.3.min.js` | `@supabase/supabase-js@2.117.3` (`dist/umd/supabase.js`) | MIT |
| `chart-4.5.1.umd.min.js` | `chart.js@4.5.1` (`dist/chart.umd.min.js`) | MIT |

Fonts in `/fonts` are Inter and JetBrains Mono, both SIL Open Font License 1.1.
