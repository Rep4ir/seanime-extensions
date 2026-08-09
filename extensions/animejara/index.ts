/// <reference path="../../online-streaming-provider.d.ts" />
/// <reference path="../../core.d.ts" />

/**
 * AnimeJara — Seanime Online Streaming Provider (Filemoon-only)
 * ------------------------------------------------------------
 * Site:  https://animejara.com   (Spanish-speaking catalog: subs + Latino/Castellano dubs)
 *
 * Scope
 *   This build deliberately supports Filemoon only. The other hosters
 *   (VOE, Vidhide, Streamhg, YourUpload, Mega, Okru, Uqload, Streamtape,
 *   …) are ignored on purpose and will be readded later once each one is
 *   reverse-engineered to the same standard. Keeping the surface tiny is
 *   what makes the duplicates / "no servers" / blank-player issues tractable.
 *
 * Episode layout
 *   AnimeJara episode pages expose one episode per number, with the
 *   available language tracks reachable via the per-language buttons
 *   (`.botones-idioma` / `.boton-idioma .lang-name`) on the page. Behind
 *   those buttons, the page keeps a JavaScript array — `enlaces` for
 *   /episode/ pages and `movieLinks` for /movie/ pages — holding, in the
 *   same order as the buttons, the multiplayer embed URL for each language.
 *
 *   Each multiplayer embed URL serves an HTML page (`<div id="lista-server">
 *   <ul id='logo-list'> <li onclick="playVideo("URL")">`) where the
 *   `URL` is a Filemoon-style embed page on a CDN-fronted domain. We fetch
 *   that Filemoon page, scan for `https://…/hls2/…/master.m3u8…` (the
 *   adaptive playlist), falling back to `…/hls2/…/index-v1-a1.m3u8…` if no
 *   master is present, and pass THAT URL to Seanime's player tagged
 *   `type: "m3u8"`. Resolving the real .m3u8 host-side is what fixes the
 *   "no EXTM3U delimiter" error and the blank internal player.
 *
 * Deduplication contract
 *   - `findEpisodes` returns ONE EpisodeDetails per (season, episode number),
 *     regardless of how many languages a page carries. The episode id simply
 *     stores season + episode number, never the audio track. The player's
 *     sub/dub toggle is handled separately (see "Sub/dub mode" below).
 *   - `findEpisodeServer` walks every language on the page and emits one
 *     `videoSource` per (language, Filemoon mirror) pair. The language is
 *     encoded in the `quality` field, e.g. `"Filemoon - Latino"`, and
 *     mirrored in `label`, so the user picks the language from the server
 *     list — never by duplicating the episode row.
 *
 * Sub/dub mode
 *   Content providers do not have DOM access, so the `<div data-vc-element>`
 *   "Switch to Dub" toggle cannot be observed directly. The only documented
 *   channel from the UI to a provider is `SearchOptions.dub`, which Seanime
 *   passes to `search` whenever the user toggles mode. We therefore encode
 *   the requested mode into the `search` result id with a stable suffix:
 *
 *       {kind}:{slug}              // sub mode (opts.dub === false)
 *       {kind}:{slug}::DUB         // dub mode (opts.dub === true)
 *
 *   `findEpisodes` strips the suffix to know the active mode, then keeps
 *   only the episode-page languages that belong to it (sub ⇒ japones only;
 *   dub ⇒ latino + castellano). The episode id carries the mode:
 *
 *       {kind}:{slug}::S{s}::E{e}::{MODE}    // MODE = "SUB" | "DUB"
 *
 *   This keeps one row per episode but still lets the user switch the
 *   language set by toggling the in-player button (which re-issues `search`
 *   with `opts.dub = true`).
 *
 * Timeouts / no-servers
 *   The Filemoon intermediate page can be slow / occasionally Cloudflare-
 *   gated. We bump the per-request timeout to 40s, send browser-like
 *   headers + a Seanime-referer, retry the fetch once on transient failure,
 *   and gracefully skip languages we cannot resolve instead of failing the
 *   whole `findEpisodeServer` call.
 */

class Provider {

    baseUrl = "https://animejara.com"
    ajaxUrl = "https://animejara.com/wp-admin/admin-ajax.php"

    // Stable, browser-like UA passed on every request.
    private static UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"

    // Languages we recognise on the AnimeJara page. JAPONES maps to "sub";
    // LATINO / CASTELLANO / ESPAÑOL are dubs. Anything we don't recognise is
    // surfaced verbatim so untranslated audio tags still work.
    private static readonly LANG_JAPONESES = "JAPONES"
    private static readonly LABELS: Record<string, string> = {
        JAPONES: "Sub",
        LATINO: "Latino",
        CASTELLANO: "Castellano",
        ESPANOL: "Español",
        ESPAÑOL: "Español",
    }

    // ---------------------------------------------------------------------------
    // Settings
    // ---------------------------------------------------------------------------

    getSettings(): Settings {
        // Filemoon only, by design (see file header). The episode server list
        // is the picker surface Seanime shows the user; we list Filemoon once
        // per supported language so the in-player "Switch to Dub" toggle plus
        // the server list together expose every language cleanly.
        return {
            episodeServers: ["Filemoon"],
            supportsDub: true,
        }
    }

    // ---------------------------------------------------------------------------
    // HTTP helpers
    // ---------------------------------------------------------------------------

    private _baseHeaders(referer?: string): Record<string, string> {
        const h: Record<string, string> = {
            "User-Agent": Provider.UA,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9,es;q=0.8",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "same-origin",
            "Upgrade-Insecure-Requests": "1",
        }
        if (referer) h["Referer"] = referer
        return h
    }

    // HTTP GET that returns text. Tolerates the 404 the site occasionally
    // answers with while still serving the correct body (broken WP rewrite).
    // Also detects the "soft-404" gate (200 OK but body says "Episodio no encontrado en URL.").
    private async _getHtml(url: string, referer?: string): Promise<string> {
        const res = await fetch(url, {
            headers: this._baseHeaders(referer),
            timeout: 40,
        })
        if (res.status !== 200 && res.status !== 404) {
            throw new Error(`HTTP ${res.status} fetching ${url}`)
        }
        const html = res.text()
        // Detect the soft-404 gate: site returns 200 but with a stub page.
        if (html.indexOf("Episodio no encontrado en URL") >= 0 ||
            html.indexOf("Episodio no encontrado") >= 0) {
            throw new Error(
                `Soft-404 gate triggered for "${url}". ` +
                `The site is blocking automated requests (Cloudflare/geo gate). ` +
                `Open the episode page in a browser first to establish a session, ` +
                `then retry.`
            )
        }
        return html
    }

    // GET with one retry. Used for the Filemoon intermediate page, which can
    // be flaky / intermittently gated.
    private async _getHtmlRetry(url: string, referer?: string, acceptCrossSite = false): Promise<string | null> {
        const headers: Record<string, string> = {
            "User-Agent": Provider.UA,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9,es;q=0.8",
            "Sec-Fetch-Dest": "iframe",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": acceptCrossSite ? "cross-site" : "same-origin",
        }
        if (referer) headers["Referer"] = referer

        // For Filemoon/CDN domains, add extra headers that help bypass Cloudflare
        const host = (() => { try { return new URL(url).hostname.toLowerCase() } catch { return "" } })()
        const isFilemoonCdn = host.indexOf("filemoon") >= 0
            || host.indexOf("bysekoze") >= 0
            || host.indexOf("kiwi") >= 0
            || host.indexOf("kkj") >= 0
            || host.indexOf("ed33360e") >= 0
            || host.indexOf(".sbs") > 0
            || host.indexOf(".sx") > 0
            || host.indexOf("sprintcdn") >= 0
        if (isFilemoonCdn) {
            headers["Accept"] = "*/*"
            headers["Sec-Fetch-Dest"] = "empty"
            headers["Sec-Fetch-Mode"] = "cors"
            headers["Cache-Control"] = "no-cache"
            headers["Pragma"] = "no-cache"
        }

        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const res = await fetch(url, { headers, timeout: 40 })
                if (res.status !== 200) {
                    if (res.status >= 500 && attempt === 0) continue // retry once
                    return null
                }
                const html = res.text()
                // Detect soft-404 gate on retry path too
                if (html.indexOf("Episodio no encontrado en URL") >= 0 ||
                    html.indexOf("Episodio no encontrado") >= 0) {
                    return null
                }
                return html
            } catch {
                if (attempt === 0) continue // retry once on transport error
                return null
            }
        }
        return null
    }

    // ---------------------------------------------------------------------------
    // Misc helpers
    // ---------------------------------------------------------------------------

    private _norm(s: string): string {
        return (s || "")
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[^a-z0-9\s]/g, " ")
            .replace(/\s+/g, " ")
            .trim()
    }

    private _similarity(query: string, candidate: string): number {
        const q = this._norm(query).split(" ").filter(Boolean)
        if (q.length === 0) return 0
        const c = this._norm(candidate)
        const hits = q.filter((w) => c.includes(w)).length
        return hits / q.length
    }

    // Decode the entities AnimeJara emits inline (", &#038;, &#x27;, &#039;).
    // We treat a bare `&` (no amp;) as no-op, so URL query strings like
    // "?a=1&b=2" round-trip untouched.
    private _decodeEntities(s: string): string {
        if (!s) return s
        return s
            .replace(/"|&#0?34;|&#x0?22;|"/g, '"')
            .replace(/&#0?38;|&/g, "&")
            .replace(/&#x0?27;|&#0?39;|'/g, "'")
            .replace(/&#0?60;|</g, "<")
            .replace(/&#0?62;|>/g, ">")
            .replace(/&nbsp;/g, " ")
    }

    // Pretty UI label for an audio tag.
    private _audioLabel(audio: string): string {
        const a = (audio || "").toUpperCase()
        if (Provider.LABELS[a]) return Provider.LABELS[a]
        return a || "Sub"
    }

    // Whether a given audio tag counts as a dub (anything but Japanese/sub).
    private _isDubAudio(audio: string): boolean {
        const a = (audio || "").toUpperCase()
        return a !== Provider.LANG_JAPONESES && a !== "" && a !== "SUB"
    }

    // ---------------------------------------------------------------------------
    // search
    // ---------------------------------------------------------------------------

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const query = (opts.query || "").trim()
        if (query.length < 2) return []

        // `live_search` is the WP AJAX endpoint wired to the on-site search box.
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
        try { data = res.json() } catch { return [] }
        const animes: any[] = data && data.success && data.data && data.data.animes
        if (!Array.isArray(animes)) return []

        const results: SearchResult[] = animes.map((a: any) => {
            const slug: string = a.slug || ""
            const tipo: string = (a.tipo || "").toLowerCase()
            const isMovie = tipo === "movie" || tipo === "pelicula" || tipo === "película"
            const kind = isMovie ? "movie" : "anime"
            const url = `${this.baseUrl}/${kind}/${slug}`

            // Encode the active sub/dub mode in the id so `findEpisodes`
            // (which has no `dub` flag of its own) can serve the right set.
            // We keep `subOrDub: "both"` so the player's toggle stays visible.
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
    // findEpisodes  — one row per episode number, mode-tagged
    // ---------------------------------------------------------------------------

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const { contentId, wantsDub } = this._parseContentIdWithMode(id)
        const { kind, slug } = this._parseContentId(contentId)
        const url = `${this.baseUrl}/${kind}/${slug}`

        const html = await this._getHtml(url, this.baseUrl + "/inicio")
        const temporadas = this._extractTemporadasData(html)

        const episodes: EpisodeDetails[] = []
        const MODE = wantsDub ? "DUB" : "SUB"

        if (temporadas && temporadas.length > 0) {
            // ---- Series: TEMPORADAS_DATA lists seasons + per-episode audios.
            for (const season of temporadas) {
                const seasonNum = Number(season.numero_temporada)
                if (!Number.isFinite(seasonNum)) continue
                const eps: any[] = Array.isArray(season.episodios) ? season.episodios : []

                for (const ep of eps) {
                    const epNum = Number(ep.numero_episodio)
                    if (!Number.isInteger(epNum)) continue

                    const idiomas: string[] = Array.isArray(ep.idiomas) ? ep.idiomas : []
                    const audios = idiomas.length > 0 ? idiomas : [Provider.LANG_JAPONESES]

                    // Drop episodes that have no source in the active mode.
                    // They reappear as soon as the user toggles mode (which
                    // re-runs `search` with `opts.dub` flipped).
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
            // ---- Movies: /movie/{slug} is the episode-1 view. Read the
            // on-page audio buttons and emit at most one row, mode-tagged.
            const audios = this._extractPageAudios(html)
            const list = (audios.length > 0 ? audios : [Provider.LANG_JAPONESES]) as string[]
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
    // findEpisodeServer — Filemoon only, grouped by language
    // ---------------------------------------------------------------------------

    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        const meta = this._parseEpisodeId(episode.id)
        if (!meta) throw new Error(`Invalid episode id: "${episode.id}"`)

        const pageUrl = meta.kind === "movie"
            ? `${this.baseUrl}/movie/${meta.slug}`
            : `${this.baseUrl}/episode/${meta.slug}-${meta.season}x${meta.episode}/`

        // Try regular fetch first. If it hits the soft-404 gate, fall back to
        // ChromeDP (headless Chrome) which can pass Cloudflare challenges.
        let html: string
        try {
            html = await this._getHtml(pageUrl, this.baseUrl + "/")
        } catch (e: any) {
            const msg = String(e?.message || e)
            if (msg.indexOf("Soft-404 gate") >= 0) {
                html = await this._getHtmlWithChromeDP(pageUrl)
            } else {
                throw e
            }
        }

        // ---- Strategy 1: Server-rendered player block (real episode page).
        // Look for the canonical player wrapper + iframe + language buttons.
        const pairs = this._extractIframeUrlsByLanguage(html)
        if (pairs.length > 0) {
            return this._resolveSourcesFromPairs(pairs, meta, pageUrl, server)
        }

        // ---- Strategy 2: Fallback — episode page might have a different
        // template (e.g. movie page uses slightly different classes). Try
        // broad iframe + boton-idioma sweep.
        const fallbackPairs = this._extractIframeUrlsByLanguageBroad(html)
        if (fallbackPairs.length > 0) {
            return this._resolveSourcesFromPairs(fallbackPairs, meta, pageUrl, server)
        }

        // If both strategies fail, we hit the soft-404 gate. Throw a clear
        // error so the user sees "no servers" instead of an infinite spinner.
        throw new Error(
            `Could not locate player iframe on "${pageUrl}". ` +
            `The site may be blocking the request (Cloudflare / geo gate). ` +
            `Try opening the page in a browser first to establish a session.`
        )
    }

    /**
     * Fetch an episode page using ChromeDP (headless Chrome) to bypass
     * Cloudflare/geo gates. Returns the page HTML after JS execution.
     * This is slower but more reliable for gated pages.
     */
    private async _getHtmlWithChromeDP(url: string): Promise<string> {
        let browser: any = null
        try {
            browser = await ChromeDP.newBrowser({ headless: true, timeout: 60 })
            await browser.navigate(url)
            // Wait for the player wrapper to appear (it's rendered server-side,
            // but we also wait a bit for any dynamic content)
            await browser.waitReady("#reproductor-wrapper", 30)
            // Give a moment for any lazy-loaded iframes
            await browser.sleep(2000)
            return await browser.outerHTML("html")
        } catch (e: any) {
            throw new Error(
                `ChromeDP failed to load episode page "${url}": ${e?.message || e}. ` +
                `Ensure Chrome/Chromium is installed on the Seanime host.`
            )
        } finally {
            if (browser) {
                try { await browser.close() } catch { /* ignore */ }
            }
        }
    }

    /**
     * Parse the server-rendered player block:
     *   <div id="reproductor-wrapper"> <iframe id="iframe-video" src="..."> ...
     *   <div class="botones-idioma"> <button class="boton-idioma" data-idioma="LATINO">...
     * Returns (audioLabel, iframeUrl) pairs. Prefers `data-idioma` on the
     * iframe if present; otherwise pairs by index order (button[0] ↔ iframe[0]).
     */
    private _extractIframeUrlsByLanguage(html: string): Array<{ audio: string; embedUrl: string }> {
        const pairs: Array<{ audio: string; embedUrl: string }> = []
        try {
            const $ = LoadDoc(html)
            // Find the player wrapper
            const wrapper = $("#reproductor-wrapper")
            if (!wrapper.length) return pairs

            // Extract iframe URLs from the wrapper (could be one per language
            // or a single iframe with language-switch data-attrs)
            const iframes: Array<{ url: string; langAttr: string | null }> = []
            wrapper.find("iframe#iframe-video").each((_, el) => {
                const src = $(el).attr("src") || ""
                if (!src) return
                // Some templates put data-idioma / data-lang / data-audio on
                // the iframe itself — that’s the cleanest pairing.
                const langAttr =
                    $(el).attr("data-idioma") ||
                    $(el).attr("data-lang") ||
                    $(el).attr("data-audio") ||
                    null
                iframes.push({ url: src.trim(), langAttr: langAttr ? langAttr.toUpperCase() : null })
            })

            // Extract language buttons
            const buttons: Array<{ lang: string }> = []
            $(".botones-idioma .boton-idioma, .boton-idioma").each((_, el) => {
                const lang =
                    $(el).attr("data-idioma") ||
                    $(el).attr("data-lang") ||
                    $(el).attr("data-audio") ||
                    $(el).find(".lang-name").text() ||
                    $(el).text()
                const t = (lang || "").trim().toUpperCase()
                if (t) buttons.push({ lang: t })
            })

            // Pairing logic
            if (iframes.length === 0) return pairs

            if (iframes.length === buttons.length && buttons.length > 0) {
                // 1:1 pairing by order (button[0] ↔ iframe[0])
                for (let i = 0; i < iframes.length; i++) {
                    pairs.push({ audio: buttons[i].lang, embedUrl: iframes[i].url })
                }
            } else if (iframes.length === 1 && buttons.length > 0) {
                // Single iframe + multiple languages — the iframe src is a
                // multiplayer embed that itself contains the language list.
                // We'll pass each language with the same embed URL; the
                // multiplayer embed will serve the right language.
                for (const btn of buttons) {
                    pairs.push({ audio: btn.lang, embedUrl: iframes[0].url })
                }
            } else if (iframes.length > 0) {
                // Multiple iframes, no buttons (or button count mismatch).
                // Use iframe's own data-idioma if available; else fall back
                // to JAPONES for the first, then LATINO/CASTELLANO for rest.
                const langOrder = [Provider.LANG_JAPONESES, "LATINO", "CASTELLANO", "ESPAÑOL"]
                for (let i = 0; i < iframes.length; i++) {
                    const lang = iframes[i].langAttr || langOrder[i] || Provider.LANG_JAPONESES
                    pairs.push({ audio: lang, embedUrl: iframes[i].url })
                }
            }
        } catch { /* fall through to broad */ }
        return pairs
    }

    /**
     * Broad fallback: find any iframe whose src looks like an animejara
     * multiplayer embed (streamhj.top/embed.php), and any element that
     * looks like a language selector (boton-idioma, botones-idioma,
     * lang-name, lang-code). Pair by index or use iframe data-attrs.
     */
    private _extractIframeUrlsByLanguageBroad(html: string): Array<{ audio: string; embedUrl: string }> {
        const pairs: Array<{ audio: string; embedUrl: string }> = []
        try {
            const $ = LoadDoc(html)
            // Collect candidate embed iframes (streamhj / multiplayer / embed.php)
            const embedIframes: Array<{ url: string; langAttr: string | null }> = []
            $("iframe[src]").each((_, el) => {
                const src = $(el).attr("src") || ""
                if (!src) return
                // AnimeJara embed URLs contain these markers
                if (src.indexOf("streamhj.top") < 0 && src.indexOf("embed.php") < 0 && src.indexOf("multiplayer") < 0) return
                const langAttr =
                    $(el).attr("data-idioma") ||
                    $(el).attr("data-lang") ||
                    $(el).attr("data-audio") ||
                    null
                embedIframes.push({ url: src.trim(), langAttr: langAttr ? langAttr.toUpperCase() : null })
            })
            if (embedIframes.length === 0) return pairs

            // Collect language selectors (broad match)
            const langSelectors = [
                ".botones-idioma .boton-idioma",
                ".boton-idioma",
                "[data-idioma]",
                "[data-lang]",
                "[data-audio]",
                ".lang-name",
                ".lang-code",
            ]
            const buttons: Array<{ lang: string }> = []
            for (const sel of langSelectors) {
                $(sel).each((_, el) => {
                    const lang =
                        $(el).attr("data-idioma") ||
                        $(el).attr("data-lang") ||
                        $(el).attr("data-audio") ||
                        $(el).find(".lang-name").text() ||
                        $(el).text()
                    const t = (lang || "").trim().toUpperCase()
                    if (t) buttons.push({ lang: t })
                })
                if (buttons.length > 0) break // first selector that yields results wins
            }

            // Pair by order if counts match; else use iframe data-attrs
            if (embedIframes.length === buttons.length && buttons.length > 0) {
                for (let i = 0; i < embedIframes.length; i++) {
                    pairs.push({ audio: buttons[i].lang, embedUrl: embedIframes[i].url })
                }
            } else if (embedIframes.length === 1 && buttons.length > 0) {
                for (const btn of buttons) pairs.push({ audio: btn.lang, embedUrl: embedIframes[0].url })
            } else {
                const langOrder = [Provider.LANG_JAPONESES, "LATINO", "CASTELLANO", "ESPAÑOL"]
                for (let i = 0; i < embedIframes.length; i++) {
                    const lang = embedIframes[i].langAttr || langOrder[i] || Provider.LANG_JAPONESES
                    pairs.push({ audio: lang, embedUrl: embedIframes[i].url })
                }
            }
        } catch { /* give up */ }
        return pairs
    }

    /**
     * Given a list of (audioLabel, multiplayerEmbedUrl) pairs, resolve each
     * to a real Filemoon .m3u8 URL and build the EpisodeServer response.
     * Filters to the active mode (sub ⇒ JAPONES; dub ⇒ everything else).
     */
    private async _resolveSourcesFromPairs(
        allPairs: Array<{ audio: string; embedUrl: string }>,
        meta: { slug: string; season: number; episode: number; wantsDub: boolean },
        pageUrl: string,
        server: string
    ): Promise<EpisodeServer> {
        // Keep only languages matching the active mode
        const pairs = allPairs.filter((p) => {
            const isDub = this._isDubAudio(p.audio)
            return meta.wantsDub === isDub
        })

        if (pairs.length === 0) {
            throw new Error(
                `No ${meta.wantsDub ? "dub" : "sub"} language found on the page for "${meta.slug}" ` +
                `S${meta.season}E${meta.episode}.`
            )
        }

        const videoSources: VideoSource[] = []
        for (const pair of pairs) {
            const langLabel = this._audioLabel(pair.audio)

            // The multiplayer embed page hosts the Filemoon mirror <li>.
            const filemoonEmbedUrl = await this._extractFilemoonEmbedUrl(pair.embedUrl, pageUrl)
            if (!filemoonEmbedUrl) {
                // Log for debugging: which language failed at embed extraction
                continue // skip this language
            }

            const stream = await this._resolveFilemoonStream(filemoonEmbedUrl, pair.embedUrl)
            if (!stream) {
                // Log for debugging: which language failed at stream extraction
                continue
            }

            videoSources.push({
                url: stream,
                type: "m3u8" as VideoSourceType,
                quality: `Filemoon - ${langLabel}`,
                label: langLabel,
                subtitles: [],
            })
        }

        if (videoSources.length === 0) {
            // Include debug info in error
            const langs = pairs.map(p => this._audioLabel(p.audio)).join(", ")
            throw new Error(
                `Could not resolve any Filemoon stream for "${meta.slug}" ` +
                `S${meta.season}E${meta.episode} (${meta.wantsDub ? "dub" : "sub"}). ` +
                `Tried languages: ${langs}. ` +
                `Check if episode page loads player iframe (soft-404 gate).`
            )
        }

        let chosenServer = server
        if (!videoSources.some((v) => v.quality === server)) {
            chosenServer = videoSources[0].quality
        }

        // Referer the Filemoon CDN expects: the multiplayer embed host.
        let refererHost = pageUrl
        try {
            const u = new URL(pairs[0].embedUrl)
            refererHost = `${u.protocol}//${u.host}/`
        } catch { /* keep pageUrl fallback */ }

        return {
            server: chosenServer,
            headers: {
                Referer: refererHost,
                "User-Agent": Provider.UA,
                Origin: this.baseUrl,
            },
            videoSources: videoSources,
        }
    }

    // ===========================================================================
    // Parsing helpers
    // ===========================================================================

    private _parseContentIdWithMode(id: string): { contentId: string; wantsDub: boolean } {
        const raw = id || ""
        if (raw.endsWith("::DUB")) {
            return { contentId: raw.slice(0, -("::DUB".length)), wantsDub: true }
        }
        return { contentId: raw, wantsDub: false }
    }

    private _parseContentId(id: string): { kind: "anime" | "movie"; slug: string } {
        const sep = (id || "").indexOf(":")
        if (sep < 0) return { kind: "anime", slug: id || "" }
        const kind = id.slice(0, sep)
        const slug = id.slice(sep + 1)
        if (kind !== "movie" && kind !== "anime") return { kind: "anime", slug: id }
        return { kind: kind as "anime" | "movie", slug: slug || "" }
    }

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
     * Extract the `TEMPORADAS_DATA` JSON array the series page emits as a JS
     * const. Balanced-scanning the bracket literal (instead of a greedy
     * regex) is both faster and more robust on large episode blobs.
     */
    private _extractTemporadasData(html: string): any[] | null {
        const marker = "TEMPORADAS_DATA"
        const at = html.indexOf(marker)
        if (at < 0) return null
        let i = html.indexOf("[", at)
        if (i < 0) return null

        let depth = 0, inStr = false, esc = false
        const start = i
        for (; i < html.length; i++) {
            const ch = html.charCodeAt(i)
            if (inStr) {
                if (esc) esc = false
                else if (ch === 0x5c) esc = true
                else if (ch === 0x22) inStr = false
                continue
            }
            if (ch === 0x22) { inStr = true; continue }
            if (ch === 0x5b) depth++
            else if (ch === 0x5d) {
                depth--
                if (depth === 0) { i++; break }
            }
        }
        const json = html.slice(start, i)
        try { return JSON.parse(json) } catch { return null }
    }

    /**
     * Pull the ordered list of audio tags shown on a page (movie or episode)
     * from the `.botones-idioma .lang-name` (or `.boton-idioma .lang-name`)
     * elements. Order matches the embed arrays (`enlaces`/`movieLinks`).
     */
    private _extractPageAudios(html: string): string[] {
        const audios: string[] = []
        try {
            const $ = LoadDoc(html)
            $("div.boton-idioma .lang-name, div.boton-idioma .lang-code, .botones-idioma .lang-name").each((_, el) => {
                const t = (el.text() || "").trim().toUpperCase()
                if (t) audios.push(t)
            })
            if (audios.length === 0) {
                // Fallback to the data-attribute some templates emit.
                $("div.boton-idioma[data-audio]").each((_, el) => {
                    const t = (el.attr("data-audio") || "").trim().toUpperCase()
                    if (t) audios.push(t)
                })
            }
        } catch {
            // Regex fallback for lang-name divs.
            const re = /<div class="lang-name">([^<]+)<\/div>/g
            let m: RegExpExecArray | null
            while ((m = re.exec(html)) !== null) {
                const t = m[1].trim().toUpperCase()
                if (t) audios.push(t)
            }
        }
        return audios
    }

    // ===========================================================================
    // Filemoon extraction (the only hoster this build supports)
    // ===========================================================================
    //
    // The iframe chain is:
    // 1. Episode page → iframe to multiplayer.streamhj.top/player/multiplayer/embed.php?...
    //    (the "HenaoJara Player" wrapper)
    // 2. That wrapper page contains an iframe to the Filemoon embed
    //    (e.g., https://bysekoze.com/e/<id> or similar CDN-fronted domain)
    // 3. The Filemoon embed page loads the actual stream via XHR. The tokenized
    //    master.m3u8 URL is often embedded in the page HTML in obfuscated form
    //    (in script tags, data attributes, or JavaScript variables) even though
    //    the browser fetches it dynamically. We extract it server-side by
    //    fetching the Filemoon page and scanning for the m3u8 URL pattern.

    /**
     * Fetch the AnimeJara multiplayer embed page (streamhj.top) and return the
     * Filemoon embed iframe URL it contains.
     */
    private async _extractFilemoonEmbedUrl(
        embedUrl: string,
        referer: string
    ): Promise<string | null> {
        const html = await this._getHtmlRetry(embedUrl, referer, true)
        if (!html) return null

        // Decode entities once so regexes see plain ASCII quotes.
        const decoded = this._decodeEntities(html)

        // The multiplayer page (streamhj.top) contains an iframe pointing to
        // the Filemoon embed. Look for it first via LoadDoc.
        try {
            const $ = LoadDoc(decoded)
            let found: string | null = null

            // Strategy 1: Find iframe with Filemoon-like src
            $("iframe[src]").each((_, el) => {
                if (found) return
                const src = $(el).attr("src") || ""
                if (!src) return
                // Filemoon embed URLs typically have "/e/<id>" path
                if (src.indexOf("/e/") >= 0) {
                    // Additional heuristic: known Filemoon CDN domains or patterns
                    const host = (() => { try { return new URL(src).hostname.toLowerCase() } catch { return "" } })()
                    const isFilemoon = host.indexOf("filemoon") >= 0
                        || host.indexOf("bysekoze") >= 0
                        || host.indexOf("kiwi") >= 0
                        || host.indexOf("kkj") >= 0
                        || host.indexOf("ed33360e") >= 0
                        || host.indexOf(".sbs") > 0
                        || host.indexOf(".sx") > 0
                        || /^https?:\/\/[^/]+\/e\/[A-Za-z0-9_-]{8,}/i.test(src)
                    if (isFilemoon) found = src
                }
            })
            if (found) return found

            // Strategy 2: Regex fallback for iframe src in HTML
            const iframeRe = /<iframe[^>]+src=(["'])(https?:\/\/[^"']+\/e\/[A-Za-z0-9_-]{8,}[^"']*)\1/i
            const m = decoded.match(iframeRe)
            if (m && m[2]) return this._safeUrl(m[2])
        } catch { /* fall through to regex */ }

        // Regex fallback: find any Filemoon-ish URL in the page
        const re = /(https?:\/\/[^\s"'<>]+\/e\/[A-Za-z0-9_-]{8,})/g
        let m: RegExpExecArray | null
        while ((m = re.exec(decoded)) !== null) {
            const url = m[1].trim()
            if (!/^https?:\/\//i.test(url)) continue
            // Heuristics for Filemoon CDN domains
            if (
                url.indexOf("filemoon") >= 0 ||
                url.indexOf("bysekoze") >= 0 ||
                url.indexOf("kiwi") >= 0 ||
                url.indexOf("kkj") >= 0 ||
                url.indexOf("ed33360e") >= 0 ||
                /^https?:\/\/[^/]+\/e\/[A-Za-z0-9_-]{8,}/i.test(url)
            ) {
                return this._safeUrl(url)
            }
        }
        return null
    }

    /**
     * Fetch the Filemoon embed page and return the master .m3u8 stream URL.
     * The Filemoon page loads the stream via XHR with dynamic tokens, but the
     * tokenized URL is often present in the page HTML in obfuscated form:
     * - In <video>/<source> tags
     * - In JavaScript variables (playerConfig, source, src, file, etc.)
     * - In data-src / data-source attributes
     * - In JSON-LD or similar structures
     * We fetch the page, normalize escape sequences, and scan comprehensively.
     * Prefers master.m3u8 (adaptive) over index-v1-a1.m3u8 (single quality).
     */
    private async _resolveFilemoonStream(
        filemoonUrl: string,
        referer: string
    ): Promise<string | null> {
        const html = await this._getHtmlRetry(filemoonUrl, referer, true)
        if (!html) return null
        const decoded = this._decodeEntities(html)
        // Normalise \x.. / \u.... escape sequences Filemoon emits in its
        // obfuscated payloads so the regex sweep sees plain ASCII.
        const normalised = this._decodeEscapeSequences(decoded)

        // The Filemoon embed ID (from the URL path /e/<id>) often appears in
        // the m3u8 path. Capture it for validation.
        const embedIdMatch = filemoonUrl.match(/\/e\/([A-Za-z0-9_-]+)/)
        const embedId = embedIdMatch ? embedIdMatch[1] : ""

        // Helper: test if a candidate URL looks like a valid Filemoon m3u8
        const isValidM3u8 = (url: string): boolean => {
            if (!/^https?:\/\//i.test(url)) return false
            if (!/\.m3u8(\?.*)?$/i.test(url)) return false
            // Relaxed: Filemoon typically uses hls2 path, but don't hard-require it
            // in case CDN structure changes. Embed ID check is also relaxed -
            // the ID may appear with suffixes (e.g., m13jtzk62ecl_x).
            if (embedId) {
                // Check if embedId appears as a path segment prefix
                const idRegex = new RegExp(`[/_-]${embedId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([_-]|$)`)
                if (!idRegex.test(url)) {
                    // As fallback, just check if the raw ID appears anywhere
                    if (url.indexOf(embedId) < 0) return false
                }
            }
            return true
        }

        // Ordered list of regex patterns from most specific to most general.
        // All capture the full URL (with query string) in group 1.
        const patterns: RegExp[] = [
            // 1) Master playlist with hls2 path (adaptive, preferred)
            /(https?:\/\/[^\s"'<>\\]+\/hls2\/[^\s"'<>\\]*\/master\.m3u8[^\s"'<>\\]*)/i,
            // 2) Master playlist variants (query-string-first, etc.)
            /(https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*[?&][^\s"'<>\\]*master[^\s"'<>\\]*)/i,
            /(https?:\/\/[^\s"'<>\\]+master\.m3u8[^\s"'<>\\]*)/i,
            // 3) Single-quality index-v1-a1.m3u8 (hls2 path)
            /(https?:\/\/[^\s"'<>\\]+\/hls2\/[^\s"'<>\\]+\/index-v\d+-a\d+\.m3u8[^\s"'<>\\]*)/i,
            // 4) Any hls2 + .m3u8 URL
            /(https?:\/\/[^\s"'<>\\]+hls2[^\s"'<>\\]*\.m3u8[^\s"'<>\\]*)/i,
            // 5) Video/source tag src attributes
            /<video[^>]+src=(["'])(https?:\/\/[^"']+\.m3u8[^"']*)\1/i,
            /<source[^>]+src=(["'])(https?:\/\/[^"']+\.m3u8[^"']*)\1/i,
            // 6) Common JS variable patterns in script tags
            /(?:source|src|file|videoUrl|m3u8Url|playlistUrl)\s*[:=]\s*(["'])(https?:\/\/[^"']+\.m3u8[^"']*)\1/i,
            /(?:masterPlaylist|adaptivePlaylist)\s*[:=]\s*(["'])(https?:\/\/[^"']+\.m3u8[^"']*)\1/i,
            // 7) data-src / data-source attributes
            /data-(?:src|source|m3u8)=(["'])(https?:\/\/[^"']+\.m3u8[^"']*)\1/i,
            // 8) JSON structures with file/source keys
            /["']file["']\s*:\s*(["'])(https?:\/\/[^"']+\.m3u8[^"']*)\1/i,
            /["']source["']\s*:\s*(["'])(https?:\/\/[^"']+\.m3u8[^"']*)\1/i,
            // 9) Absolute last resort: any .m3u8 URL
            /(https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*)/i,
        ]

        for (const pattern of patterns) {
            const match = normalised.match(pattern)
            if (match && match[1]) {
                const url = this._safeUrl(match[1])
                if (isValidM3u8(url)) return url
            }
        }

        return null
    }

    // ---------------------------------------------------------------------------
    // Small string helpers
    // ---------------------------------------------------------------------------

    /** Decode \x.. and \u.... escape sequences the Filemoon payload emits. */
    private _decodeEscapeSequences(s: string): string {
        if (!s || s.indexOf("\\") < 0) return s
        return s
            .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
            .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    }

    /** Trim trailing character-class junk regexes sometimes capture. */
    private _safeUrl(u: string): string {
        return (u || "").replace(/[\\]+/g, "").replace(/["'<>\\]+$/g, "").trim()
    }
}

if (typeof window !== "undefined" && (window as any).registerProvider) {
    (window as any).registerProvider(new Provider())
}
