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
 * Audio-variant strategy
 *   AnimeJara stores, per episode, the list of available audio tracks
 *   (typically "JAPONES" = subbed Japanese, "LATINO" = Spanish dub; some
 *   titles are sub-only or dub-only, many are both). For every (episode,
 *   audio) pair we emit a separate `EpisodeDetails` entry so the user can
 *   pick the variant they want. The variant is encoded in `id` with a
 *   stable, parseable shape:
 *
 *       {kind}:{slug}::S{season}::E{episode}::{AUDIO}
 *
 *   e.g.  anime:sentai-daishikkaku::S1::E23::LATINO
 *         movie:la-leyenda-de-aang-el-ultimo-maestro-aire::S1::E1::JAPONES
 *
 *   `findEpisodeServer` parses that id, hits the corresponding /episode/
 *   (or /movie/) page, locates the per-language embed URL from the
 *   `enlaces` / `movieLinks` JS array (kept in the same order as the
 *   `botones-idioma` buttons), then lists every mirror returned by the
 *   embed page (filemoon, voe, vidhide, streamhg, …) as a separate
 *   `videoSources` entry.
 *
 *   The mirror URLs are external-host embed pages (e.g.
 *   https://filemoon…/e/xyz) whose real stream link is produced by
 *   client-side JavaScript; they are returned with `type: "unknown"` so
 *   Seanime's player loads them in its JS-capable webview — same approach
 *   as the jkanime/kwik reference extension.
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
        if (a === "LATINO") return "LATINO"
        if (a === "ESPAÑOL" || a === "ESPANOL") return "ESP"
        if (a === "CASTELLANO") return "CAST"
        return a || "SUB"
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

            // We don't know the audio make-up until we read the title page, so
            // default to "both" when dubs are supported. This is purely a hint
            // for the Seanime UI; the per-episode truth comes from
            // `findEpisodes`.
            const subOrDub: SubOrDub = opts.dub ? "both" : "sub"

            return {
                id: `${kind}:${slug}`,
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
        const { kind, slug } = this._parseContentId(id)
        const url = `${this.baseUrl}/${kind}/${slug}`

        const html = await this._getHtml(url, this.baseUrl + "/inicio")
        const temporadas = this._extractTemporadasData(html)

        const episodes: EpisodeDetails[] = []

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
                    // If the JSON omitted idiomas (older entries), default to SUB.
                    const audios = idiomas.length > 0 ? idiomas : ["JAPONES"]

                    const epTitle: string = (ep.nombre_episodio || "").trim()
                    const epUrl = `${this.baseUrl}/episode/${slug}-${seasonNum}x${epNum}/`

                    for (const audio of audios) {
                        const label = this._audioLabel(audio)
                        episodes.push({
                            id: `${kind}:${slug}::S${seasonNum}::E${epNum}::${audio.toUpperCase()}`,
                            number: epNum,
                            url: epUrl,
                            title: epTitle || `Episodio ${epNum}${audios.length > 1 ? ` (${label})` : ""}`,
                        })
                    }
                }
            }
        } else if (kind === "movie") {
            // ---- Movies: no seasons JSON; the /movie/{slug} page is itself the
            // episode 1 view. Read the per-audio embed list there.
            const audios = this._extractPageAudios(html)
            const list = (audios.length > 0 ? audios : ["JAPONES"]) as string[]
            for (const audio of list) {
                episodes.push({
                    id: `${kind}:${slug}::S1::E1::${audio.toUpperCase()}`,
                    number: 1,
                    url: url,
                    title: `Película (${this._audioLabel(audio)})`,
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

        // Locate the embed-URL array that matches the requested audio variant.
        const embedUrl = this._extractEmbedUrlForAudio(html, meta.audio)
        if (!embedUrl) {
            throw new Error(
                `No embed found for "${meta.slug}" S${meta.season}E${meta.episode} (${meta.audio}).`
            )
        }

        // Pull the list of mirror servers from the embed page.
        const mirrors = await this._extractMirrors(embedUrl, pageUrl)
        if (mirrors.length === 0) {
            // Last-ditch fallback: surface the animejara embed itself. Seanime's
            // player can render the iframe, which in turn shows the server list.
            mirrors.push({ name: "AnimeJara", url: embedUrl })
        }

        const audioLabel = this._audioLabel(meta.audio)
        const videoSources: VideoSource[] = mirrors.map((m) => ({
            url: m.url,
            type: "unknown" as VideoSourceType,
            quality: `${m.name} - ${audioLabel}`,
            label: audioLabel,
            subtitles: [],
        }))

        return {
            server: server || mirrors[0].name,
            headers: {
                Referer: pageUrl,
                Origin: this.baseUrl,
            },
            videoSources: videoSources,
        }
    }

    // ===========================================================================
    // Parsing helpers
    // ===========================================================================

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
     *   {kind}:{slug}::S{season}::E{episode}::{AUDIO}
     */
    private _parseEpisodeId(id: string): {
        kind: "anime" | "movie"
        slug: string
        season: number
        episode: number
        audio: string
    } | null {
        const m = id.match(/^(anime|movie):(.+?)::S(\d+)::E(\d+)::([^:]+)$/)
        if (!m) return null
        return {
            kind: m[1] as "anime" | "movie",
            slug: m[2],
            season: Number(m[3]),
            episode: Number(m[4]),
            audio: m[5],
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
     * From an episode or movie page, return the multiplayer embed URL that
     * corresponds to the requested audio variant. The page keeps the per-audio
     * embed URLs in a JS array (`enlaces` for episodes, `movieLinks` for
     * movies), in the same order as the `.botones-idioma` buttons.
     */
    private _extractEmbedUrlForAudio(html: string, audio: string): string | undefined {
        const audios = this._extractPageAudios(html)
        const links = this._extractEmbedLinks(html)
        if (links.length === 0) return undefined

        // If we managed to read both lists and lengths line up, index by audio.
        if (audios.length === links.length) {
            const idx = audios.indexOf(audio.toUpperCase())
            if (idx >= 0) return this._decodeEntities(links[idx])
        }

        // Otherwise, fall back to the first link (the page's default variant).
        return this._decodeEntities(links[0])
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
}

if (typeof window !== "undefined" && (window as any).registerProvider) {
    (window as any).registerProvider(new Provider())
}
