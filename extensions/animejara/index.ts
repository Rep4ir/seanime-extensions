/// <reference path="../../online-streaming-provider.d.ts" />
/// <reference path="../../core.d.ts" />

/**
 * AnimeJara — Seanime Online Streaming Provider
 * --------------------------------------------
 * Site:  https://animejara.com/inicio   (Spanish-speaking catalog: subs + Latino dubs)
 * Stack: WordPress front-end + a custom API/server at hj.animejara.com and
 *        multiplayer.streamhj.top for the actual video embeds.
 *
 * Cloudflare note
 *   Plain HTTP GET works for the WordPress-rendered pages (/inicio, /anime/*,
 *   /movie/*, /episode/*, /wp-admin/admin-ajax.php). Seanime's `fetch` already
 *   negotiates the Cloudflare turnstile for us when `noCloudflareBypass` is
 *   not set, so we rely on the runtime's built-in handling and keep the
 *   browser-like headers. If a future change were to harden /episode/, the
 *   same code path is the only thing that would need touching — every method
 *   already shares `_get`/`_getHtml`.
 *
 * Sub / Dub strategy (see Seanime online-streaming-provider contract)
 *   AnimeJara keeps, per episode, a list of available audio tracks
 *   (typically "JAPONES" = subbed Japanese, "LATINO" / "CASTELLANO" /
 *   "ESPAÑOL" = Spanish dubs; some titles are sub-only or dub-only, many
 *   are both).
 *
 *   Seanime content providers have no DOM access, so the player's sub/dub
 *   toggle (the <div data-vc-element> "Switch to Dub" button) cannot be
 *   observed directly. The only documented channel from the UI to a
 *   provider is `SearchOptions.dub`, which Seanime passes to `search`
 *   whenever the user toggles the mode. We therefore encode the requested
 *   mode into the `SearchResult.id` we return:
 *
 *       {kind}:{slug}              // sub mode (opts.dub === false)
 *       {kind}:{slug}::DUB         // dub mode (opts.dub === true)
 *
 *   `findEpisodes` strips the trailing `::DUB` selector off the id to learn
 *   the active mode, then emits ONE EpisodeDetails per episode number
 *   (never per audio variant), encoding the mode in the episode id
 *
 *       {kind}:{slug}::S{season}::E{episode}::{MODE}    // MODE = "SUB" | "DUB"
 *
 *   This is what eliminates the duplicate episodes reported in production:
 *   an anime with sub + latino + castellano used to produce three rows per
 *   episode; now every episode has a single slot, regardless of how many
 *   dubs it has.
 *
 *   `findEpisodeServer` parses the MODE, fetches the /episode/ (or /movie/)
 *   page once, walks the `enlaces`/`movieLinks` array in step with the
 *   `.botones-idioma` audio buttons, and keeps only the embed URLs that
 *   correspond to the active mode (sub ⇒ only JAPONES; dub ⇒ every
 *   non-JAPONES track). For each (embed URL × mirror) pair it then
 *   resolves the real `.m3u8` / `.mp4` stream URL by fetching the embed
 *   page and decoding the hoster's payload (VOE base64, filemoon/vidhide
 *   eval-packer, generic regex fallback), and emits one `VideoSource`
 *   per (mirror, language), tagged with the language in `quality`
 *   (e.g. "VOE - Latino") and `label` (e.g. "Latino").
 *
 *   The user therefore selects the language by picking a server from the
 *   server list — exactly the desired UX.
 *
 * Playback note (HLS)
 *   Mirrors are external-host embed PAGES (e.g. https://filemoon…/e/xyz)
 *   whose body is HTML, not an HLS playlist. Seanime's built-in player
 *   passes `videoSources[].url` straight to an HLS parser when
 *   `type === "m3u8"`. Returning the embed URL with `type: "unknown"`
 *   (the previous behaviour) made the parser download the HTML embed
 *   page and try to read #EXTM3U out of it — producing the production
 *   error "HLS error: no EXTM3U delimiter". The playground masked this
 *   because it ran the embed pages through an internal JS-capable
 *   webview, but that path is not part of the documented contract. The
 *   fix here is to resolve the real stream URL host-side (same approach
 *   as the kwik example in the Seanime docs) and tag it `"m3u8"` / `"mp4"`.
 */

class Provider {

    baseUrl = "https://animejara.com"
    ajaxUrl = "https://animejara.com/wp-admin/admin-ajax.php"

    // Stable, browser-like UA passed on every request.
    private static UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"

    // ---------------------------------------------------------------------------
    // Settings
    // ---------------------------------------------------------------------------

    getSettings(): Settings {
        // Episode servers are not chosen up-front on AnimeJara; the embed page
        // exposes them dynamically per episode. We list the most common ones so
        // the UI surface stays meaningful, but `findEpisodeServer` returns all
        // the mirrors it actually finds regardless of this list.
        return {
            episodeServers: ["AnimeJara", "Filemoon", "Streamhg", "Vidhide", "Voe"],
            supportsDub: true,
        }
    }

    // ---------------------------------------------------------------------------
    // HTTP helpers
    // ---------------------------------------------------------------------------

    // Standard browser-ish headers; reused on every request so the site treats
    // us consistently and Cloudflare's fingerprint check stays happy.
    private _baseHeaders(referer?: string): Record<string, string> {
        const h: Record<string, string> = {
            "User-Agent": Provider.UA,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "same-origin",
            "Upgrade-Insecure-Requests": "1",
        }
        if (referer) h["Referer"] = referer
        return h
    }

    // Fetch + text, throwing a descriptive error on hard failure. The site
    // occasionally answers with a 404 status but still serves the correct
    // body (broken WP rewrite), so we accept 200/404 on HTML endpoints.
    private async _getHtml(url: string, referer?: string): Promise<string> {
        const res = await fetch(url, {
            headers: this._baseHeaders(referer),
            timeout: 40,
        })
        if (res.status !== 200 && res.status !== 404) {
            throw new Error(`HTTP ${res.status} fetching ${url}`)
        }
        return res.text()
    }

    // ---------------------------------------------------------------------------
    // Misc helpers
    // ---------------------------------------------------------------------------

    private _norm(s: string): string {
        return (s || "")
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "") // strip accents
            .replace(/[^a-z0-9\s]/g, " ")
            .replace(/\s+/g, " ")
            .trim()
    }

    // Cheap token-overlap similarity used to rank search results.
    private _similarity(query: string, candidate: string): number {
        const q = this._norm(query).split(" ").filter(Boolean)
        if (q.length === 0) return 0
        const c = this._norm(candidate)
        const hits = q.filter((w) => c.includes(w)).length
        return hits / q.length
    }

    // Decode HTML entities (&#038; & " &#x27; …) that WordPress injects
    // into inline JSON / attributes.
    private _decodeEntities(s: string): string {
        if (!s) return s
        // Decode the entities AnimeJara actually emits in inline JS / iframe
        // attributes: " ("), &#038; / &#38; (amp), &#x27; / &#039;
        // (apostrophe). Everything else passes through untouched.
        return s
            .replace(/"/g, '"')
            .replace(/"/g, '"')
            .replace(/&#0?38;|&/g, "&")
            .replace(/&#x0?27;|&#0?39;|'/g, "'")
            .replace(/&#0?60;|</g, "<")
            .replace(/&#0?62;|>/g, ">")
            .replace(/&nbsp;/g, " ")
    }

    // Pretty label used in the UI for a given audio tag.
    private _audioLabel(audio: string): string {
        const a = (audio || "").toUpperCase()
        if (a === "JAPONES") return "SUB"
        if (a === "LATINO") return "Latino"
        if (a === "ESPAÑOL" || a === "ESPANOL") return "Español"
        if (a === "CASTELLANO") return "Castellano"
        return a || "SUB"
    }

    // Whether a given audio tag counts as a dub (i.e. anything other than the
    // Japanese/subbed track). Used to bucket audios into the SUB or DUB mode.
    private _isDubAudio(audio: string): boolean {
        const a = (audio || "").toUpperCase()
        return a !== "JAPONES" && a !== "" && a !== "SUB"
    }

    // ---------------------------------------------------------------------------
    // search
    // ---------------------------------------------------------------------------

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const query = (opts.query || "").trim()
        if (query.length < 2) return []

        // `live_search` is the WP AJAX endpoint wired to the on-site search box.
        // It returns JSON: { success, data: { animes: [{titulo, slug, tipo, ...}] } }
        const res = await fetch(this.ajaxUrl, {
            method: "POST",
            headers: {
                "User-Agent": Provider.UA,
                "Accept": "*/*",
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "X-Requested-With": "XMLHttpRequest",
                "Origin": this.baseUrl,
                "Referer": this.baseUrl + "/inicio",
            },
            body: `action=live_search&s=${encodeURIComponent(query)}`,
            timeout: 35,
        })

        if (res.status !== 200) return []

        let data: any
        try {
            data = res.json()
        } catch {
            return []
        }
        const animes: any[] = data && data.success && data.data && data.data.animes
        if (!Array.isArray(animes)) return []

        const results: SearchResult[] = animes.map((a: any) => {
            const slug: string = a.slug || ""
            const tipo: string = (a.tipo || "").toLowerCase()
            const isMovie =
                tipo === "movie" || tipo === "pelicula" || tipo === "película"
            const kind = isMovie ? "movie" : "anime"
            const url = `${this.baseUrl}/${kind}/${slug}`

            // Encode the player's sub/dub mode into the content id so that
            // `findEpisodes` (which receives no `dub` flag of its own) can
            // serve the right episode set. `opts.dub === true` means the
            // user clicked "Switch to Dub"; `false` is the default sub mode.
            // We keep `subOrDub: "both"` so Seanime keeps the toggle visible.
            const modeSuffix = opts.dub ? "::DUB" : ""
            const subOrDub: SubOrDub = "both"

            return {
                id: `${kind}:${slug}${modeSuffix}`,
                title: a.titulo || slug,
                url: url,
                subOrDub: subOrDub,
            }
        })

        results.sort(
            (a, b) => this._similarity(query, b.title) - this._similarity(query, a.title)
        )
        return results
    }

    // ---------------------------------------------------------------------------
    // findEpisodes
    // ---------------------------------------------------------------------------

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const { contentId, wantsDub } = this._parseContentIdWithMode(id)
        const { kind, slug } = this._parseContentId(contentId)
        const url = `${this.baseUrl}/${kind}/${slug}`

        const html = await this._getHtml(url, this.baseUrl + "/inicio")
        const temporadas = this._extractTemporadasData(html)

        const episodes: EpisodeDetails[] = []
        // MODE is encoded into every episode id so `findEpisodeServer` knows
        // which audio variants to expose as servers.
        const MODE = wantsDub ? "DUB" : "SUB"

        if (temporadas && temporadas.length > 0) {
            // ---- Series: TEMPORADAS_DATA carries seasons + per-episode audios.
            for (const season of temporadas) {
                const seasonNum = Number(season.numero_temporada)
                if (!Number.isFinite(seasonNum)) continue
                const eps: any[] = Array.isArray(season.episodios) ? season.episodios : []

                for (const ep of eps) {
                    const epNum = Number(ep.numero_episodio)
                    if (!Number.isInteger(epNum)) continue

                    const idiomas: string[] = Array.isArray(ep.idiomas) ? ep.idiomas : []
                    const audios = idiomas.length > 0 ? idiomas : ["JAPONES"]

                    // Only emit this episode if it has at least one source in
                    // the active mode. (If an anime has dub-only episodes and
                    // the user is in sub mode, those become invisible — but
                    // they will reappear the moment the user clicks "Switch
                    // to Dub", because that re-runs `search` with dub=true and
                    // produces the dub-mode ids.)
                    const hasForMode = wantsDub
                        ? audios.some((a) => this._isDubAudio(a))
                        : audios.some((a) => !this._isDubAudio(a))
                    if (!hasForMode) continue

                    const epTitle: string = (ep.nombre_episodio || "").trim()
                    const epUrl = `${this.baseUrl}/episode/${slug}-${seasonNum}x${epNum}/`

                    episodes.push({
                        id: `${kind}:${slug}::S${seasonNum}::E${epNum}::${MODE}`,
                        number: epNum,
                        url: epUrl,
                        title: epTitle || `Episodio ${epNum}`,
                    })
                }
            }
        } else if (kind === "movie") {
            // ---- Movies: no seasons JSON; the /movie/{slug} page is itself
            // the episode 1 view. The page lists the available audios; emit
            // at most one entry (mode-tagged) for episode 1, regardless of
            // how many dubs it has.
            const audios = this._extractPageAudios(html)
            const list = (audios.length > 0 ? audios : ["JAPONES"]) as string[]
            const hasForMode = wantsDub
                ? list.some((a) => this._isDubAudio(a))
                : list.some((a) => !this._isDubAudio(a))
            if (hasForMode) {
                episodes.push({
                    id: `${kind}:${slug}::S1::E1::${MODE}`,
                    number: 1,
                    url: url,
                    title: "Película",
                })
            }
        }

        if (episodes.length === 0) {
            throw new Error("No episodes found for \"" + id + "\".")
        }

        episodes.sort((a, b) => a.number - b.number)
        return episodes
    }

    // ---------------------------------------------------------------------------
    // findEpisodeServer
    // ---------------------------------------------------------------------------

    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        const meta = this._parseEpisodeId(episode.id)
        if (!meta) {
            throw new Error(`Invalid episode id: "${episode.id}"`)
        }

        const pageUrl = meta.kind === "movie"
            ? `${this.baseUrl}/movie/${meta.slug}`
            : `${this.baseUrl}/episode/${meta.slug}-${meta.season}x${meta.episode}/`

        const html = await this._getHtml(pageUrl, this.baseUrl + "/")

        // Collect every (audio, embedUrl) pair available on the page, then
        // keep only the ones that match the active mode (sub ⇒ JAPONES only;
        // dub ⇒ everything else). For multi-dub anime this yields one entry
        // per language (e.g. latino + castellano), so the user picks between
        // them via the server list — never via duplicate episode rows.
        const allAudios = this._extractPageAudios(html)
        const allLinks = this._extractEmbedLinks(html)
        const pairs: Array<{ audio: string; embedUrl: string }> = []
        if (allAudios.length === allLinks.length && allLinks.length > 0) {
            for (let i = 0; i < allLinks.length; i++) {
                const audio = (allAudios[i] || "").toUpperCase()
                const isDub = this._isDubAudio(audio)
                if (meta.wantsDub === isDub) {
                    pairs.push({ audio, embedUrl: this._decodeEntities(allLinks[i]) })
                }
            }
        } else if (allLinks.length > 0) {
            // Page didn't expose the audio buttons in a parseable way — fall
            // back to the first embed only, and (if we're in dub mode) treat
            // it as a dub so we still surface something.
            const fallbackAudio = meta.wantsDub ? "LATINO" : "JAPONES"
            pairs.push({ audio: fallbackAudio, embedUrl: this._decodeEntities(allLinks[0]) })
        }

        if (pairs.length === 0) {
            throw new Error(
                `No ${meta.wantsDub ? "dub" : "sub"} source found for "${meta.slug}" ` +
                `S${meta.season}E${meta.episode}.`
            )
        }

        const videoSources: VideoSource[] = []

        for (const pair of pairs) {
            // The embed page (streamhj multiplayer) lists the actual mirror
            // hosters (filemoon, voe, vidhide, …) as <li onclick="playVideo">.
            const mirrors = await this._extractMirrors(pair.embedUrl, pageUrl)
            if (mirrors.length === 0) {
                // No mirror scraped — last-ditch: surface the embed itself
                // and let the hoster extraction try it as a single mirror.
                mirrors.push({ name: "AnimeJara", url: pair.embedUrl })
            }

            const langLabel = this._audioLabel(pair.audio)

            for (const mirror of mirrors) {
                // The mirror URL is an HTML embed PAGE, not a stream. Resolve
                // the real .m3u8/.mp4 URL host-side so the HLS player gets a
                // proper playlist instead of "no EXTM3U delimiter".
                const resolved = await this._resolveMirrorStream(mirror.url, pair.embedUrl)
                if (!resolved) continue

                videoSources.push({
                    url: resolved.url,
                    type: resolved.type,
                    // quality must be unique across videoSources; combining the
                    // mirror name with the language tag guarantees that even
                    // when the same hoster appears under two dubs.
                    quality: `${mirror.name} - ${langLabel}`,
                    label: langLabel,
                    subtitles: [],
                })
            }
        }

        if (videoSources.length === 0) {
            throw new Error(
                `Could not resolve any playable stream for "${meta.slug}" ` +
                `S${meta.season}E${meta.episode} (${meta.wantsDub ? "dub" : "sub"}).`
            )
        }

        // Prefer the requested server / language if present; otherwise default
        // to the first resolved source. The `server` field is informational —
        // Seanime switches between videoSources using their `quality`.
        let chosenServer = server || videoSources[0].quality
        if (!videoSources.some((v) => v.quality === server)) {
            chosenServer = videoSources[0].quality
        }

        // Headers are sent on every segment request the HLS player makes, so
        // we point Referer at the embed page's host (the hoster checks it).
        let refererHost = pageUrl
        try {
            const u = new URL(pairs[0].embedUrl)
            refererHost = `${u.protocol}//${u.host}/`
        } catch { /* keep pageUrl fallback */ }

        return {
            server: chosenServer,
            headers: {
                Referer: refererHost,
                Origin: this.baseUrl,
            },
            videoSources: videoSources,
        }
    }

    // ===========================================================================
    // Parsing helpers
    // ===========================================================================

    /**
     * Parse a content-level id coming from `search`. The id may carry a
     * trailing `::DUB` selector that encodes the active sub/dub mode:
     *
     *   "anime:slug"        → sub mode
     *   "anime:slug::DUB"   → dub mode
     *
     * Returns both the stripped content id (for `_parseContentId`) and the
     * boolean `wantsDub`.
     */
    private _parseContentIdWithMode(id: string): { contentId: string; wantsDub: boolean } {
        const raw = id || ""
        if (raw.endsWith("::DUB")) {
            return { contentId: raw.slice(0, -("::DUB".length)), wantsDub: true }
        }
        return { contentId: raw, wantsDub: false }
    }

    /**
     * Parse a content-level id ("anime:slug" / "movie:slug") coming from `search`.
     */
    private _parseContentId(id: string): { kind: "anime" | "movie"; slug: string } {
        const sep = (id || "").indexOf(":")
        if (sep < 0) {
            // Be forgiving: treat the whole thing as an anime slug.
            return { kind: "anime", slug: id || "" }
        }
        const kind = id.slice(0, sep)
        const slug = id.slice(sep + 1)
        if (kind !== "movie" && kind !== "anime") {
            return { kind: "anime", slug: id }
        }
        return { kind: kind as "anime" | "movie", slug: slug || "" }
    }

    /**
     * Parse an episode-level id produced by `findEpisodes`:
     *   {kind}:{slug}::S{season}::E{episode}::{MODE}   // MODE = "SUB" | "DUB"
     */
    private _parseEpisodeId(id: string): {
        kind: "anime" | "movie"
        slug: string
        season: number
        episode: number
        wantsDub: boolean
    } | null {
        const m = id.match(/^(anime|movie):(.+?)::S(\d+)::E(\d+)::(SUB|DUB)$/)
        if (!m) return null
        return {
            kind: m[1] as "anime" | "movie",
            slug: m[2],
            season: Number(m[3]),
            episode: Number(m[4]),
            wantsDub: m[5] === "DUB",
        }
    }

    /**
     * Extract the `TEMPORADAS_DATA` JSON array that the series page emits as a
     * JS const. We grab the bracketed JSON literal directly with balanced
     * scanning rather than a greedy regex — episode data can be large and a
     * single-line regex is both slower and more fragile.
     */
    private _extractTemporadasData(html: string): any[] | null {
        const marker = "TEMPORADAS_DATA"
        const at = html.indexOf(marker)
        if (at < 0) return null

        // Find the first `[` after the marker.
        let i = html.indexOf("[", at)
        if (i < 0) return null

        let depth = 0
        let inStr = false
        let esc = false
        const start = i
        for (; i < html.length; i++) {
            const ch = html.charCodeAt(i)
            if (inStr) {
                if (esc) { esc = false }
                else if (ch === 0x5c) { esc = true } // backslash
                else if (ch === 0x22) { inStr = false } // "
                continue
            }
            if (ch === 0x22) { inStr = true; continue }
            if (ch === 0x5b) depth++        // [
            else if (ch === 0x5d) {         // ]
                depth--
                if (depth === 0) { i++; break }
            }
        }
        const json = html.slice(start, i)
        try {
            return JSON.parse(json)
        } catch {
            return null
        }
    }

    /**
     * Pull the ordered list of audio tags shown on a page (movie or episode)
     * from the `.botones-idioma .lang-name` elements. Order matches the embed
     * arrays (`enlaces` / `movieLinks`).
     */
    private _extractPageAudios(html: string): string[] {
        const audios: string[] = []
        try {
            const $ = LoadDoc(html)
            $("div.boton-idioma .lang-name").each((_, el) => {
                const t = (el.text() || "").trim().toUpperCase()
                if (t) audios.push(t)
            })
        } catch {
            // Fallback: regex sweep of lang-name divs.
            const re = /<div class="lang-name">([^<]+)<\/div>/g
            let m: RegExpExecArray | null
            while ((m = re.exec(html)) !== null) {
                const t = m[1].trim().toUpperCase()
                if (t) audios.push(t)
            }
        }
        return audios
    }

    /**
     * Extract the embed-URL JS array from an episode (`enlaces = [...]`) or
     * movie (`movieLinks = [...]`) page.
     */
    private _extractEmbedLinks(html: string): string[] {
        const out: string[] = []
        const re = /(?:enlaces|movieLinks)\s*=\s*(\[[\s\S]*?\])\s*;/
        const m = re.exec(html)
        if (!m) {
            // Final fallback: grab any streamhj embed URLs anywhere on the page.
            const fre = /https?:\/\/[^\s"'<>]+embed\.php\?idanime=\d+&idcapitulo=\d+/g
            let fm: RegExpExecArray | null
            while ((fm = fre.exec(html)) !== null) out.push(fm[0])
            return out
        }
        try {
            const arr = JSON.parse(m[1])
            if (Array.isArray(arr)) {
                for (const u of arr) if (typeof u === "string") out.push(u)
            }
        } catch {
            // Regex-extract quoted strings if JSON.parse failed.
            const qre = /"([^"]+)"/g
            let qm: RegExpExecArray | null
            while ((qm = qre.exec(m[1])) !== null) out.push(qm[1])
        }
        return out
    }

    /**
     * Hit the multiplayer embed page and pull every mirror server it offers
     * (filemoon, voe, vidhide, streamhg, …). Each `<li>` carries an
     * `onclick="playVideo(url)"` plus a server-name label.
     */
    private async _extractMirrors(
        embedUrl: string,
        referer: string
    ): Promise<Array<{ name: string; url: string }>> {
        let html: string
        try {
            const res = await fetch(embedUrl, {
                headers: {
                    "User-Agent": Provider.UA,
                    "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
                    "Referer": referer,
                },
                timeout: 35,
            })
            if (res.status !== 200) return []
            // Decode the entities the embed template emits inline (", &#038; …)
            // once, so the downstream regexes only need to handle plain ASCII
            // characters. URLs containing "&" pass through untouched.
            html = this._decodeEntities(res.text())
        } catch {
            return []
        }

        const mirrors: Array<{ name: string; url: string }> = []

        // Primary path: parse the onclick/list with LoadDoc. The embed page
        // nests mirror buttons as <li onclick="playVideo('URL')">…<img alt="x">.
        try {
            const $ = LoadDoc(html)
            $("#logo-list li").each((_, li) => {
                const onclick = li.attr("onclick") || ""
                // The URL argument is wrapped in an ASCII double-quote in the
                // (pre-decoded) raw HTML; cheerio would have decoded it too.
                // Capture lazily up to the next closing quote; the URL itself
                // may contain "&".
                const m = onclick.match(/playVideo\(\s*"\s*([\s\S]*?)\s*"\s*\)/)
                if (!m || !m[1]) return
                let url = this._decodeEntities(m[1]).trim()
                if (!url) return
                if (!/^https?:\/\//i.test(url)) return

                // Prefer the <img alt=> server name; fall back to the host.
                let name = ""
                li.find("img").each((_i, img) => {
                    const a = img.attr("alt")
                    if (a) { name = a; return }
                })
                if (!name) {
                    try { name = new URL(url).hostname.replace(/^www\./, "") }
                    catch { name = "server" }
                }
                // De-dup by URL so we don't emit the same mirror twice if the
                // page happens to render it on mobile + desktop lists.
                if (!mirrors.some((x) => x.url === url)) {
                    mirrors.push({ name: name, url: url })
                }
            })
        } catch {
            // Ignore — fall through to regex fallback.
        }

        if (mirrors.length === 0) {
            // Regex fallback: capture (url, name) pairs from the raw HTML.
            // Markup per server:
            //   <li ... onclick="...playVideo("URL")...">
            //     <script ... rocket-loader ...></script>
            //     <img alt="filemoon" ...>
            //     <span class='nombre-server'>filemoon</span>
            //   </li>
            // We pre-decoded " entities into ASCII " above, so the quote is a
            // plain ". A Cloudflare rocket-loader <script> sits between the
            // onclick and the <span class='nombre-server'> name, so the
            // bridging window is widened generously.
            const re = /playVideo\(\s*"\s*([\s\S]*?)\s*"\s*\)[\s\S]{0,500}?<span\s+class='nombre-server'>([^<]+)<\/span>/g
            let m: RegExpExecArray | null
            while ((m = re.exec(html)) !== null) {
                const url = this._decodeEntities(m[1]).trim()
                const name = (m[2] || "").trim() || "server"
                if (url && /^https?:\/\//i.test(url) && !mirrors.some((x) => x.url === url)) {
                    mirrors.push({ name: name, url: url })
                }
            }
        }

        return mirrors
    }

    // ===========================================================================
    // Mirror → real stream URL resolution (fix for "no EXTM3U delimiter").
    // ===========================================================================
    //
    // The mirror URLs returned by `_extractMirrors` are HTML embed PAGES, not
    // streams. Seanime's built-in player feeds `videoSources[].url` straight
    // to an HLS/MP4 parser as soon as `type` is "m3u8"/"mp4"; if we returned
    // the embed URL with `type: "unknown"` (old behaviour), the parser got
    // back the embed's HTML body and produced "HLS error: no EXTM3U
    // delimiter". We must resolve the real stream URL host-side, exactly like
    // the kwik example in the Seanime docs does for its `eval` payload.

    /**
     * Fetch a mirror's embed page and extract the actual stream URL+type.
     * Returns null if nothing usable was found.
     */
    private async _resolveMirrorStream(
        embedUrl: string,
        referer: string
    ): Promise<{ url: string; type: VideoSourceType } | null> {
        let html: string
        try {
            const res = await fetch(embedUrl, {
                headers: {
                    "User-Agent": Provider.UA,
                    "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
                    "Referer": referer,
                    "Sec-Fetch-Dest": "iframe",
                    "Sec-Fetch-Mode": "navigate",
                    "Sec-Fetch-Site": "cross-site",
                },
                timeout: 35,
            })
            if (res.status !== 200) return null
            html = res.text()
            // Normalise once: VOE/filemoon emit literal \x.. escape sequences
            // in obfuscated payloads; decoding them up-front lets the regex
            // extractors work on the same string regardless of hoster.
            html = this._decodeEscapeSequences(this._decodeEntities(html))
        } catch {
            return null
        }

        // If the URL itself is already a direct stream, trust it.
        if (/\.(m3u8|mp4|webm|mkv)(\?.*)?$/i.test(embedUrl)) {
            return {
                url: embedUrl,
                type: /\.m3u8(\?.*)?$/i.test(embedUrl) ? "m3u8" : "mp4",
            }
        }

        // Host-specific extraction. Order matters: VOE has the strongest
        // signal (mk hosts / fp/voe-* subdomains) and a known payload, so we
        // try it first; the eval-packer covers filemoon/vidhide/streamhg;
        // the generic regex is the safety net.
        const host = (() => {
            try { return new URL(embedUrl).hostname.toLowerCase() } catch { return "" }
        })()

        if (host.indexOf("voe") === 0 || host.indexOf("voe-") >= 0 || host.indexOf(".voe.") >= 0) {
            const r = this._voeExtract(html)
            if (r) return { url: r, type: (r.indexOf(".m3u8") >= 0 ? "m3u8" : "mp4") as VideoSourceType }
        }

        const packed = this._packedExtract(html)
        if (packed) {
            const ext = /\.m3u8(\?.*)?$/i.test(packed) ? "m3u8"
                : /\.mp4(\?.*)?$/i.test(packed) ? "mp4"
                : /\.webm(\?.*)?$/i.test(packed) ? "mp4"
                : ""
            if (ext) return { url: packed, type: ext as VideoSourceType }
        }

        // Generic regex sweep — final fallback, covers Streamhg/Nosatpel/
        // generic players that inline an m3u8 in a <source> or window var.
        const generic = this._genericStreamExtract(html, embedUrl)
        if (generic) return generic

        return null
    }

    /**
     * VOE extractor. VOE embeds either a JSON `sources` array (possibly
     * doubly-escaped), a `var mp4 = [...]` array, or a packed string. We
     * scan for the first http(s) URL that ends in `.m3u8` or `.mp4` in that
     * order, then fall back to a regex sweep for the same extensions.
     */
    private _voeExtract(html: string): string | null {
        // 1) JSON sources array: {"sources":[{"file":"https://...m3u8",...}]}
        const srcArr = html.match(/['"]sources['"]\s*:\s*\[[\s\S]*?\]/)
        if (srcArr) {
            const urls = srcArr[0].match(/https?:\/\/[^\s'"\\]+/g) || []
            for (const u of urls) {
                if (/\.m3u8(\?.*)?$/i.test(u)) return this._safeUrl(u)
                if (/\.mp4(\?.*)?$/i.test(u)) return this._safeUrl(u)
            }
        }
        // 2) var mp4 = ["https://...mp4", "https://...m3u8", ...]
        const mp4Arr = html.match(/(?:var|let|const)\s+mp4\s*=\s*\[[\s\S]*?\]/)
        if (mp4Arr) {
            const urls = mp4Arr[0].match(/https?:\/\/[^\s'"\\]+/g) || []
            for (const u of urls) {
                if (/\.m3u8(\?.*)?$/i.test(u)) return this._safeUrl(u)
                if (/\.mp4(\?.*)?$/i.test(u)) return this._safeUrl(u)
            }
        }
        // 3) window.location* redirects to an m3u8 — capture any plain URL.
        const direct = html.match(/(https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*)/i)
        if (direct && direct[1]) return this._safeUrl(direct[1])
        const directMp4 = html.match(/(https?:\/\/[^\s"'<>\\]+\.mp4[^\s"'<>\\]*)/i)
        if (directMp4 && directMp4[1]) return this._safeUrl(directMp4[1])
        return null
    }

    /**
     * Filemoon / VidHide / StreamHub extractor. These hosters ship a
     * `eval(function(p,a,c,k,e,d){...})` packer whose decoded form contains
     * `file:"<stream-url>"` or `sources:[{file:"<stream-url>"}]`. We run the
     * packer in-sandbox (Seanime's JS engine supports `eval`) and sweep the
     * decoded string for the stream URL — same approach the kwik example in
     * the Seanime docs uses.
     */
    private _packedExtract(html: string): string | null {
        // Match the packed payload, optionally over multiple lines.
        const m = html.match(/eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\)\)/)
        if (!m) return null

        // Run the packer in-sandbox. Seanime's goja JS engine supports
        // eval; the packer's own code is self-contained and safe enough.
        let decoded = ""
        try {
            // The packer calls `eval(...)` to materialise its payload. Eval'ing
            // the whole `eval(...)` expression is exactly what the hoster's
            // page does, returning the unpacked JavaScript source.
            decoded = String(eval(m[0]))
        } catch {
            // If eval is unavailable or fails, try the manual unpack: the
            // decoded token list is in the `|`-delimited string near the end.
            const inner = m[0].match(/'([^']{8,})'\.split\('\|'\)/)
            if (!inner) return null
            const tokens = inner[1].split("|")
            // Re-hydrate the template portion: find the first token that
            // looks like a URL.
            for (const t of tokens) {
                if (/^https?:\/\//i.test(t) && /\.(m3u8|mp4|webm)(\?.*)?$/i.test(t)) {
                    return this._safeUrl(t)
                }
            }
            return null
        }
        if (!decoded) return null

        // Search the decoded payload for the stream URL. Match the common
        // assignments first (file:"<url>", source:"<url>", sources:[...]).
        const fileMatch = decoded.match(/['"]?file['"]?\s*[:=]\s*['"]([^'"]+\.(?:m3u8|mp4|webm)[^'"]*)['"]/i)
        if (fileMatch && fileMatch[1]) return this._safeUrl(fileMatch[1])
        const srcMatch = decoded.match(/['"]?src['"]?\s*[:=]\s*['"]([^'"]+\.(?:m3u8|mp4|webm)[^'"]*)['"]/i)
        if (srcMatch && srcMatch[1]) return this._safeUrl(srcMatch[1])
        const sourcesArr = decoded.match(/['"]?sources['"]?\s*[:=]\s*\[[\s\S]*?\]/)
        if (sourcesArr) {
            const urls = sourcesArr[0].match(/https?:\/\/[^\s'"\\]+/g) || []
            for (const u of urls) {
                if (/\.(m3u8|mp4|webm)(\?.*)?$/i.test(u)) return this._safeUrl(u)
            }
        }
        // Last sweep on the decoded string.
        const raw = decoded.match(/(https?:\/\/[^\s"'<>\\]+\.(?:m3u8|mp4|webm)[^\s"'<>\\]*)/i)
        if (raw && raw[1]) return this._safeUrl(raw[1])
        return null
    }

    /**
     * Generic stream URL extractor. Tries the patterns used by the kwik
     * reference extension (source=, video src=, m3u8 in <source>,
     * hls.loadSource, plain "file":), then a final regex sweep.
     */
    private _genericStreamExtract(html: string, embedUrl: string): { url: string; type: VideoSourceType } | null {
        const patterns: RegExp[] = [
            /(?:file|src|video_url|source|url)\s*[:=]\s*["']([^"']+\.(?:m3u8|mp4|webm)[^"']*)["']/i,
            /<source\s+src=["']([^"']+\.(?:m3u8|mp4|webm)[^"']*)["']/i,
            /hls\.loadSource\(\s*["']([^"']+\.m3u8[^"']*)["']\s*\)/i,
            /source=["']([^"']+\.(?:m3u8|mp4|webm)[^"']*)["']/i,
            /["']file["']\s*:\s*["']([^"']+)["']/i,
            /["']url["']\s*:\s*["']([^"']+)["']/i,
            /(https?:\/\/[^\s'"]+\.(?:m3u8|mp4|webm)[^\s'"]*)/i,
        ]
        for (const p of patterns) {
            const m = html.match(p)
            if (m && m[1]) {
                let url = m[1]
                if (url.indexOf("//") === 0) url = "https:" + url
                else if (url.indexOf("/") === 0) {
                    try {
                        const u = new URL(embedUrl)
                        url = `${u.protocol}//${u.host}${url}`
                    } catch { /* give up */ }
                } else if (url.indexOf("http") !== 0) {
                    try { url = new URL(url, embedUrl).toString() } catch { /* give up */ }
                }
                if (/^https?:\/\//i.test(url)) {
                    const type: VideoSourceType = /\.m3u8(\?.*)?$/i.test(url) ? "m3u8" : "mp4"
                    return { url: this._safeUrl(url), type }
                }
            }
        }
        return null
    }

    /**
     * Decode \x.. and \u.... escape sequences that obfuscated hoster payloads
     * embed in their HTML. Also normalises stray '\\u00' escapes. URLs and
     * everything else pass through untouched (the canonical URL chars are all
     * plain ASCII).
     */
    private _decodeEscapeSequences(s: string): string {
        if (!s || s.indexOf("\\") < 0) return s
        return s
            .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
            .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    }

    /**
     * Trim trailing junk that regexes sometimes capture (trailing commas,
     * quotes, escaped slashes). Keeps the URL parser-friendly.
     */
    private _safeUrl(u: string): string {
        return (u || "").replace(/[\\]+/g, "").replace(/["'<>\\]+$/g, "").trim()
    }
}

if (typeof window !== "undefined" && (window as any).registerProvider) {
    (window as any).registerProvider(new Provider())
}
