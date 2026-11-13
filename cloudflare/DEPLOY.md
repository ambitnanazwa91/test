# TamaRodzina — automatyczny deploy Cloudflare Workera

Ten projekt to **istniejący** Worker `tama-api` oraz istniejąca baza D1 `tama`.
Nie twórz kolejnego Workera ani bazy.

## Jednorazowa konfiguracja

1. W Cloudflare otwórz **Storage & databases > D1 > tama**. Znajdź **Database ID**.
2. W pliku `wrangler.toml.example` wstaw prawdziwy identyfikator w polu `database_id`, a następnie zapisz go pod nazwą **`wrangler.toml`** w tym samym folderze `cloudflare/`.
3. Dopiero wtedy na Cloudflare otwórz **Workers & Pages > tama-api > Settings > Builds > Connect**.
4. Połącz repozytorium GitHub **`ambitnanazwa91/test`** i gałąź **`main`**.
5. W ustawieniach build ustaw:
   - **Root directory:** `cloudflare`
   - **Build command:** brak / puste
   - **Deploy command:** `npx wrangler deploy`
   - **Build watch paths (Include):** `cloudflare/*` (jeśli dostępne)
6. Autoryzuj integrację w Cloudflare. Nie umieszczaj żadnego hasła/klucza w repozytorium.

Po konfiguracji kolejne commity zmieniające `cloudflare/tama-api.js` automatycznie
uruchomią nowe wdrożenie tego samego Workera. Frontend w `tama-rodzina/`
pozostaje obsługiwany przez GitHub Pages.

## Bezpieczeństwo

- Nie zapisuj wartości `TAMA_API_KEY` do plików repozytorium.
- `keep_vars = true` zachowuje zmienne ustawione przez panel Cloudflare.
- `[[d1_databases]]` musi wskazywać **istniejącą** bazę `tama`, nie nową.
- Nie podłączaj automatycznych buildów do produkcji, dopóki w repozytorium nie ma kompletnego `wrangler.toml`.
- Sprawdź na koniec: `https://tama-api.yoszhi.workers.dev/health`.
- Zachowaj lokalną kopię danych TamaRodzina przed pierwszym wdrożeniem z GitHuba.

Dokumentacja: https://developers.cloudflare.com/workers/ci-cd/builds/
