
# API README — ścieżki `pathname === …` w `server.js`

Ten serwer HTTP (Node.js) wystawia kilka punktów końcowych sprawdzanych w kodzie przez warunek
`pathname === '…'`. Poniżej znajdziesz spis wszystkich takich ścieżek wraz z krótkim opisem sposobu
użycia na podstawie pliku `server.js`.

> **Uwaga o autoryzacji i CORS**
>
> - **Webhooki (POST)** wymagają **Basic Auth** (`Authorization: Basic …`).  
> - **GET / API** nie wymagają autoryzacji.  
> - Odpowiedzi są w JSON (`content-type: application/json`).  
> - Włączony CORS: `access-control-allow-origin: *` i `access-control-allow-headers: Content-Type, Authorization`.  
> - Limit rozmiaru ciała dla webhooków: domyślnie ok. **256 KiB** (wartość konfigurowalna: `config.limits.bodyBytes`).  
> - Błędy: 400 (złe dane), 401 (brak/niepoprawny Basic Auth), 404 (brak trasy), 405 (POST poza dozwolonymi hookami), 413 (ciało zbyt duże), 5xx (błędy DB).

## Spis ścieżek (dokładnie te z `pathname ===`)

### Webhooki (POST)
- `/`  
- `/hooks/janus`  
- `/janus`  
- `/events`  
  - **Metoda:** `POST`  
  - **Opis:** przyjmuje JSON z wydarzeniami (hook z Janusa) i przekazuje do `handleEvent(...)`.  
  - **Autoryzacja:** **Basic Auth obowiązkowy**.  
  - **Odpowiedzi:** `204 No Content` (OK), `400` (błąd parsowania/obsługi), `401` (auth), `413` (ciało zbyt duże).

### Health-check (GET, bez autoryzacji)
- `/health`  
- `/api/health`  
  - **Metoda:** `GET`  
  - **Opis:** szybki test połączenia z DB (`SELECT 1`).  
  - **Odpowiedź:** `{"ok": true}` lub `{"ok": false, "error": "…"}`.

### REST API (GET)

- `/api/sessions`  
  - **Metoda:** `GET`  
  - **Parametry:** —  
  - **Opis:** ostatnie identyfikatory sesji (distinct, max 1000).  
  - **Zwraca:** listę obiektów `{"session": <number>}`.

- `/api/handles?session=…`  
  - **Metoda:** `GET`  
  - **Parametry:** `session` *(wymagany)*.  
  - **Opis:** uchwyty (handles) w ramach wskazanej sesji (max 1000).  
  - **Zwraca:** `{"handle": <number>}`.

- `/api/stats/series?session=…&handle=…&from=…&to=…&bucket=…`  
  - **Metoda:** `GET`  
  - **Parametry:** `session`, `handle`, `from`, `to` *(wszystkie wymagane)*; `bucket` *(opc., domyślnie `1m`; dozwolone: `1s,5s,10s,30s,1m,2m,5m,15m`)*.  
  - **Opis:** szeregi czasowe metryk RTP/połączenia zagregowane do kubełków `bucket`.  
  - **Zwraca m.in.:** `ts, jitterlocal, jitterremote, rtt, in_lq, in_mlq, out_lq, out_mlq, lostlocal, lostremote, packetssent, packetsrecv, nackssent, nacksrecv, tx_bps, rx_bps, tx_bps_inst, rx_bps_inst, retransmissions_recv`.

- `/api/events/recent?session=…&handle=…&limit=…`  
  - **Metoda:** `GET`  
  - **Parametry:** `session`, `handle` *(wymagane)*; `limit` *(opc., domyślnie `50`, max `500`)*.  
  - **Opis:** ostatnie zdarzenia dla `session/handle`: `ICE`, `DTLS`, `JSEP` (dla JSEP krótki wycinek SDP).  
  - **Zwraca:** listę `[{ "time": "...", "type": "ICE|DTLS|JSEP", "state"/"value": "...", "detail": "..." }]` posortowaną malejąco.

- `/api/sip/calls?from=…&to=…&search=…&limit=…`  
  - **Metoda:** `GET`  
  - **Parametry:** `from`, `to` *(opc., filtr czasu)*; `search` *(opc., ILIKE po `call_id`, `from_uri`, `to_uri`)*; `limit` *(opc., domyślnie `200`, max `1000`)*.  
  - **Opis:** lista połączeń SIP wraz z ostatnio wybranymi parami IP/port (selected pairs).  
  - **Zwraca m.in.:** `call_id, session, handle, from_uri, to_uri, direction, created_at, sp_selected, sp_local, sp_local_type, sp_local_proto, sp_remote, sp_remote_type, sp_remote_proto`.

- `/api/stats/series/by-call?call_id=…&from=…&to=…&bucket=…`  
  - **Metoda:** `GET`  
  - **Parametry:** `call_id`, `from`, `to` *(wymagane)*; `bucket` *(opc., jak wyżej)*.  
  - **Opis:** szeregi czasowe metryk odnalezione po `call_id` (wewnętrznie mapowane do `session/handle`).  
  - **Zwraca:** te same kolumny co `/api/stats/series`.

- `/api/events/by-call?call_id=…&from=…&to=…`  
  - **Metoda:** `GET`  
  - **Parametry:** `call_id`, `from`, `to` *(wymagane)*.  
  - **Opis:** zdarzenia `ICE/DTLS/JSEP` dla `call_id`; opcjonalnie dołączane `SLOWLINK` (jeżeli istnieje tabela `slowlinks`).  
  - **Zwraca:** `{ "session": ..., "handle": ..., "events": [ { "ts": "...", "type": "...", "value": "...", "detail": "..." } ] }`.

- `/api/sip/flow/by-call?call_id=…&from=…&to=…&limit=…`  
  - **Metoda:** `GET`  
  - **Parametry:** `call_id` *(wymagany)*; `from`, `to` *(opc.)*; `limit` *(opc., domyślnie `2000`, max `10000`)*.  
  - **Opis:** uproszczona oś czasu zdarzeń SIP powiązanych z `call_id` (wykrywanie po `Call-ID` lub treści SIP).  
  - **Zwraca:** `{ "participants": ["Janus","SIP peer"], "messages": [ { "ts": "...", "dir": "in|out", "kind": "request|response", "label": "...", "cseq": "..." } ] }`.

- `/api/sip/flow/by-sh?session=…&handle=…&from=…&to=…&limit=…`  
  - **Metoda:** `GET`  
  - **Parametry:** `session`, `handle` *(wymagane)*; `from`, `to` *(opc.)*; `limit` *(opc., domyślnie `800`, max `5000`)*.  
  - **Opis:** oś czasu zdarzeń SIP po `session/handle` z parsowaniem start-linii i nagłówków.  
  - **Zwraca:** `{ "session": ..., "handle": ..., "participants": ["Janus","SIP Peer"], "messages": [ { "ts": "...", "dir": "in|out", "kind": "request|response", "label": "...", "from_uri": "...", "to_uri": "...", "cseq": "..." } ] }`.

---

## Konwencje parametrów

- **Czas**: `from` / `to` przekazywane jako `timestamptz` (ISO 8601, np. `2024-01-01T12:00:00Z`).  
- **Bucket**: `1s, 5s, 10s, 30s, 1m, 2m, 5m, 15m` → wewnętrznie mapowane na sekundy.  
- **Limit**: każda trasa ma własne wartości domyślne i maksymalne (patrz wyżej).

## Przykładowe zapytania `curl`

```bash
# Health
curl -s http://HOST:PORT/health

# Listy sesji i handle
curl -s "http://HOST:PORT/api/sessions"
curl -s "http://HOST:PORT/api/handles?session=1234567890"

# Metryki dla S/H (ostatnia godzina, kubełek 1m)
curl -s "http://HOST:PORT/api/stats/series?session=123&handle=456&from=2024-01-01T10:00:00Z&to=2024-01-01T11:00:00Z&bucket=1m"

# Zdarzenia niedawne i po call_id
curl -s "http://HOST:PORT/api/events/recent?session=123&handle=456&limit=100"
curl -s "http://HOST:PORT/api/events/by-call?call_id=abcd-1234&from=2024-01-01T10:00:00Z&to=2024-01-01T11:00:00Z"

# SIP flow
curl -s "http://HOST:PORT/api/sip/flow/by-call?call_id=abcd-1234&limit=2000"
curl -s "http://HOST:PORT/api/sip/flow/by-sh?session=123&handle=456&limit=800"

# Webhook (BasicAuth: user:pass -> dXNlcjpwYXNz)
curl -i -X POST "http://HOST:PORT/hooks/janus"   -H "Authorization: Basic dXNlcjpwYXNz"   -H "Content-Type: application/json"   -d '{"event":"test"}'
```

---

### Źródło
Powyższy opis został wygenerowany automatycznie na podstawie realnego kodu `server.js`. Zidentyfikowane ścieżki:



---

## Rejestrowanie eventów Janus → tabele i pola (z `eventHandler.js`)

> Ten rozdział opisuje jak zdarzenia z **Janus Gateway** są mapowane na rekordy w bazie i co oznaczają pola.
> Czas (`timestamp`) jest normalizowany z mikro/mili sekund do `Date`.

### `sessions`
*Zdarzenia na poziomie sesji (`type=1`).*
- **session** — Identyfikator sesji Janus (`session_id`).
- **event** — Zdarzenie zapisane jako tekst (JSON `event.data` w przypadku plugin/transport).
- **timestamp** — Czas zdarzenia po normalizacji do `Date` (w pliku konwertowane z µs/ms/s).

### `handles`
*Zdarzenia na poziomie handle (`type=2`).*
- **session** — Identyfikator sesji Janus (`session_id`).
- **handle** — Identyfikator uchwytu/handle Janus (`handle_id`).
- **event** — Zdarzenie zapisane jako tekst (JSON `event.data` w przypadku plugin/transport).
- **plugin** — Pełna nazwa pluginu (np. `janus.plugin.videoroom`, `janus.plugin.sip`).
- **timestamp** — Czas zdarzenia po normalizacji do `Date` (w pliku konwertowane z µs/ms/s).

### `sdps`
*Zdarzenia JSEP/SDP (`type=8`).*
- **session** — Identyfikator sesji Janus (`session_id`).
- **handle** — Identyfikator uchwytu/handle Janus (`handle_id`).
- **remote** — Czy SDP pochodziło od zdalnego endpointu (`owner=='remote'`).
- **offer** — Czy SDP było ofertą (`jsep.type=='offer'`).
- **sdp** — Treść SDP (Session Description Protocol).
- **timestamp** — Czas zdarzenia po normalizacji do `Date` (w pliku konwertowane z µs/ms/s).

### `ice`
*Zmiany stanu ICE (`type=16`, `subtype=1`).*
- **session** — Identyfikator sesji Janus (`session_id`).
- **handle** — Identyfikator uchwytu/handle Janus (`handle_id`).
- **stream** — Identyfikator strumienia w obrębie PeerConnection (ICE `stream_id`).
- **component** — Identyfikator komponentu (1=RTP, 2=RTCP dla klasycznego układu).
- **state** — Stan (np. ICE/DTLS/PeerConnection).
- **timestamp** — Czas zdarzenia po normalizacji do `Date` (w pliku konwertowane z µs/ms/s).

### `selectedpairs`
*Wyboru pary kandydatów ICE (`type=16`, `subtype=4`).*
- **session** — Identyfikator sesji Janus (`session_id`).
- **handle** — Identyfikator uchwytu/handle Janus (`handle_id`).
- **stream** — Identyfikator strumienia w obrębie PeerConnection (ICE `stream_id`).
- **component** — Identyfikator komponentu (1=RTP, 2=RTCP dla klasycznego układu).
- **selected** — Wybrana para kandydatów ICE w formie tekstowej (local↔remote).
- **timestamp** — Czas zdarzenia po normalizacji do `Date` (w pliku konwertowane z µs/ms/s).

### `dtls`
*Zmiany stanu DTLS (`type=16`, `subtype=5`).*
- **session** — Identyfikator sesji Janus (`session_id`).
- **handle** — Identyfikator uchwytu/handle Janus (`handle_id`).
- **state** — Stan (np. ICE/DTLS/PeerConnection).
- **timestamp** — Czas zdarzenia po normalizacji do `Date` (w pliku konwertowane z µs/ms/s).

### `connections`
*Stan PeerConnection (`type=16`, `subtype=6`).*
- **session** — Identyfikator sesji Janus (`session_id`).
- **handle** — Identyfikator uchwytu/handle Janus (`handle_id`).
- **state** — Stan (np. ICE/DTLS/PeerConnection).
- **timestamp** — Czas zdarzenia po normalizacji do `Date` (w pliku konwertowane z µs/ms/s).

### `media`
*Start/stop odbioru mediów (`type=32`, `subtype=1`).*
- **session** — Identyfikator sesji Janus (`session_id`).
- **handle** — Identyfikator uchwytu/handle Janus (`handle_id`).
- **medium** — Typ medium (`audio`/`video`).
- **receiving** — Czy Janus aktualnie otrzymuje media dla danego medium.
- **timestamp** — Czas zdarzenia po normalizacji do `Date` (w pliku konwertowane z µs/ms/s).

### `stats`
*Okresowe statystyki RTCP i jakości (`type=32`, `subtype=3`).*
- **session** — Identyfikator sesji Janus (`session_id`).
- **handle** — Identyfikator uchwytu/handle Janus (`handle_id`).
- **subtype** — Podtyp zdarzenia (dla `type=32`: 1=medium state, 2=slow link, 3=report/stats).
- **mid** — Identyfikator m-line/`mid` z SDP.
- **mindex** — Indeks m‑line w SDP (`mindex`).
- **codec** — Nazwa/identyfikator kodeka dla strumienia.
- **medium** — Typ medium (`audio`/`video`).
- **base** — Wartość bazowa z kontekstu RTCP (np. `base_seq`).
- **lsr** — Last Sender Report (NTP 'middle 32 bits') otrzymany od nadawcy.
- **lostlocal** — Liczba pakietów utraconych po stronie lokalnej (Janus → peer).
- **lostremote** — Liczba pakietów utraconych raportowana przez zdalnego peer'a.
- **jitterlocal** — Jitter mierzony lokalnie (Janus) dla danego strumienia.
- **jitterremote** — Jitter raportowany po stronie zdalnej (z RTCP).
- **packetssent** — Łączna liczba wysłanych pakietów (Janus → peer).
- **packetsrecv** — Łączna liczba odebranych pakietów (peer → Janus).
- **bytessent** — Łączna liczba wysłanych bajtów.
- **bytesrecv** — Łączna liczba odebranych bajtów.
- **nackssent** — Liczba wysłanych NACK (żądania retransmisji) do peer'a.
- **nacksrecv** — Liczba odebranych NACK od peer'a.
- **rtt** — Szacowany Round‑Trip Time (ms).
- **rtt_ntp** — RTT liczony w domenie NTP (jeśli dostępny).
- **rtt_lsr** — Czas od ostatniego Sender Report (LSR).
- **rtt_dlsr** — Delay since Last Sender Report (DLSR).
- **in_link_quality** — Wskaźnik jakości łącza przychodzącego (RTCP).
- **in_media_link_quality** — Wskaźnik jakości łącza przychodzących mediów (RTCP).
- **out_link_quality** — Wskaźnik jakości łącza wychodzącego (RTCP).
- **out_media_link_quality** — Wskaźnik jakości łącza wychodzących mediów (RTCP).
- **bytes_sent_lastsec** — Bajty wysłane w ostatniej sekundzie (okno zdarzenia).
- **bytes_recv_lastsec** — Bajty odebrane w ostatniej sekundzie (okno zdarzenia).
- **retransmissions_recv** — Liczba odebranych retransmisji w ostatniej sekundzie.
- **timestamp** — Czas zdarzenia po normalizacji do `Date` (w pliku konwertowane z µs/ms/s).

### `slowlinks`
*Wykryte problemy z łączem ('slow link') zapisywane surowo.*
- **session** — Identyfikator sesji Janus (`session_id`).
- **handle** — Identyfikator uchwytu/handle Janus (`handle_id`).
- **payload** — Surowy JSON zdarzenia 'slow link' (rdzeń lub plugin); struktura zależna od źródła.
- **timestamp** — Czas zdarzenia po normalizacji do `Date` (w pliku konwertowane z µs/ms/s).

### `sip_calls`
*Mapowanie `janus.plugin.sip` → `Call-ID` ↔ `session/handle`.*
- **session** — Identyfikator sesji Janus (`session_id`).
- **handle** — Identyfikator uchwytu/handle Janus (`handle_id`).
- **call_id** — Wartość nagłówka SIP `Call-ID` zmapowana do `session/handle`.
- **from_uri** — Strona wywołująca (URI).
- **to_uri** — Strona wywoływana (URI).
- **direction** — Kierunek połączenia SIP (`in`/`out`).
- **created_at** — Czas pierwszego skojarzenia połączenia (na podstawie zdarzenia).

### `plugins`
*Zdarzenia pochodzące z pluginów (`type=64`).*
- **session** — Identyfikator sesji Janus (`session_id`).
- **handle** — Identyfikator uchwytu/handle Janus (`handle_id`).
- **plugin** — Pełna nazwa pluginu (np. `janus.plugin.videoroom`, `janus.plugin.sip`).
- **event** — Zdarzenie zapisane jako tekst (JSON `event.data` w przypadku plugin/transport).
- **timestamp** — Czas zdarzenia po normalizacji do `Date` (w pliku konwertowane z µs/ms/s).

### `transports`
*Zdarzenia pochodzące z transportów (`type=128`).*
- **session** — Identyfikator sesji Janus (`session_id`).
- **handle** — Identyfikator uchwytu/handle Janus (`handle_id`).
- **plugin** — Pełna nazwa pluginu (np. `janus.plugin.videoroom`, `janus.plugin.sip`).
- **event** — Zdarzenie zapisane jako tekst (JSON `event.data` w przypadku plugin/transport).
- **timestamp** — Czas zdarzenia po normalizacji do `Date` (w pliku konwertowane z µs/ms/s).

### `core`
*Zdarzenia rdzenia Janus (`type=256`, np. start/stop).*
- **name** — Nazwa stanu rdzenia (np. `status` dla startu/stopu).
- **value** — Wartość stanu rdzenia (możliwy `signum` przy zamknięciu).
- **timestamp** — Czas zdarzenia po normalizacji do `Date` (w pliku konwertowane z µs/ms/s).

#### Uwagi dot. wartości w polach stanu
- **ICE `state`** — tekstowa nazwa stanu zgodna z libnice (np. `new`, `checking`, `connected`, `completed`, `failed`, `disconnected`, `closed`).
- **DTLS `state`** — stan handshaku/połączenia DTLS (np. `connected`, `closed`, `failed`).
- **`selected` (selected-pair)** — para lokalny↔zdalny kandydat w postaci tekstowej (adresy i porty).
- **`receiving`** — `true/false`; czy Janus w danej chwili odbiera media dla `audio`/`video`.
- **Link quality (`*_link_quality`)** — wskaźniki jakości wyliczane z RTCP (Receiver/Sender Reports).
