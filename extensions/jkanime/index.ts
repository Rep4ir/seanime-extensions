/// <reference path="../../online-streaming-provider.d.ts" />

/**
 * JKAnime - Online Streaming Provider for jkanime.net
 *
 * Flow:
 *  1. search()         → POST /ajax_search with CSRF
 *  2. findEpisodes()   → POST /ajax/episodes/{animeId}/{page} with CSRF (paginated)
 *  3. findEpisodeServer() → 
 *      - Desu/Magi: lógica original (basada en video[N] y botones).
 *      - Otros servidores: 
 *        - Si tiene 'u' → decodifica y sigue.
 *        - Si tiene 'e' → busca enlace de descarga directa en el HTML.
 *      Servidores soportados: Desu, Magi, Streamwish, VOE, Vidhide, Filemoon, Mixdrop, Mp4upload.
 */

class Provider {

    baseUrl = "https://jkanime.net"

    // Dominios característicos de cada servidor (solo para referencia, no se usan en la nueva lógica)
    serverDomains: Record<string, string[]> = {
        "streamwish": ["streamwish.com", "sfastwish.com", "flaswish.com"],
        "voe": ["voe.sx", "jennifereconomicgive.com"],
        "vidhide": ["vidhide.com", "vidhidevip.com"],
        "filemoon": ["filemoon.sx", "bysekoze.com"],
        "mixdrop": ["mixdrop.co", "mixdrop.top", "miixdrop.net"],
        "mp4upload": ["mp4upload.com"],
    }

    getSettings(): Settings {
        const settings = {
            episodeServers: ["Desu", "Magi", "Streamwish", "VOE", "Vidhide", "Filemoon", "Mixdrop", "Mp4upload"],
            supportsDub: true,
        };
        console.log("getSettings called, returning:", settings);
        return settings;
    }

    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------

    async _getSession(): Promise<{ csrfToken: string; cookieHeader: string }> {
        const res = await fetch(this.baseUrl, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
        });

        const html = await res.text();
        const csrfMatch = html.match(/<meta name="csrf-token" content="([^"]+)"/);
        const csrfToken = csrfMatch ? csrfMatch[1] : "";

        const cookies = res.cookies || {};
        const cookieHeader = Object.keys(cookies)
            .map((k) => `${k}=${cookies[k]}`)
            .join("; ");

        return { csrfToken, cookieHeader };
    }

    _normalise(s: string): string {
        return s
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    _similarity(query: string, candidate: string): number {
        const qWords = this._normalise(query).split(" ");
        const cNorm = this._normalise(candidate);
        const matches = qWords.filter((w) => cNorm.includes(w)).length;
        return matches / qWords.length;
    }

    /**
     * Extract video URL from an iframe page content using multiple patterns.
     * Usado para Desu/Magi y como fallback genérico.
     */
    _extractStreamFromPage(html: string, iframeUrl: string): string {
        if (/\.(m3u8|mp4|webm|mkv)(\?.*)?$/i.test(iframeUrl)) {
            return iframeUrl;
        }

        const nestedIframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
        if (nestedIframeMatch && nestedIframeMatch[1]) {
            const nestedUrl = nestedIframeMatch[1];
            if (/\.(m3u8|mp4|webm)(\?.*)?$/i.test(nestedUrl)) {
                return nestedUrl;
            }
            return nestedUrl;
        }

        const patterns = [
            /(?:file|src|video_url|source|url)\s*[:=]\s*["']([^"']+\.(?:m3u8|mp4|webm)[^"']*)["']/i,
            /<source\s+src=["']([^"']+\.(?:m3u8|mp4|webm)[^"']*)["']/i,
            /hls\.loadSource\(\s*["']([^"']+\.m3u8[^"']*)["']\s*\)/i,
            /src=["']([^"']+\.(?:m3u8|mp4|webm)[^"']*)["']/i,
            /["']file["']\s*:\s*["']([^"']+)["']/i,
            /["']url["']\s*:\s*["']([^"']+)["']/i,
            /video\s+src=["']([^"']+)["']/i,
            /(https?:\/\/[^\s'"]+\.(?:m3u8|mp4|webm)[^\s'"]*)/i,
        ];

        for (const pattern of patterns) {
            const match = html.match(pattern);
            if (match && match[1]) {
                let url = match[1];
                if (url.startsWith("/")) {
                    const base = new URL(iframeUrl);
                    url = `${base.protocol}//${base.host}${url}`;
                } else if (!url.startsWith("http")) {
                    try {
                        url = new URL(url, iframeUrl).toString();
                    } catch (_) { /* ignore */ }
                }
                return url;
            }
        }

        return "";
    }

    // ---------------------------------------------------------------------------
    // search
    // ---------------------------------------------------------------------------

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const { csrfToken, cookieHeader } = await this._getSession();

        const res = await fetch(`${this.baseUrl}/ajax_search`, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "X-Requested-With": "XMLHttpRequest",
                "X-CSRF-TOKEN": csrfToken,
                "Referer": this.baseUrl,
                "Cookie": cookieHeader,
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            },
            body: `q=${encodeURIComponent(opts.query)}`,
        });

        if (!res.ok) return [];

        let data: any[];
        try {
            data = res.json();
        } catch (_) {
            return [];
        }

        if (!Array.isArray(data)) return [];

        const results: SearchResult[] = data.map((item: any) => ({
            id: item.slug,
            title: item.title,
            url: `${this.baseUrl}/${item.slug}/`,
            subOrDub: "sub" as SubOrDub,
        }));

        results.sort((a, b) => this._similarity(opts.query, b.title) - this._similarity(opts.query, a.title));
        return results;
    }

    // ---------------------------------------------------------------------------
    // findEpisodes
    // ---------------------------------------------------------------------------

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const slug = id;

        const animePageRes = await fetch(`${this.baseUrl}/${slug}/`, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            },
        });

        if (!animePageRes.ok) {
            throw new Error(`Anime page not found for slug "${slug}" (status ${animePageRes.status})`);
        }

        const animeHtml = await animePageRes.text();
        const animeIdMatch = animeHtml.match(/data-anime="(\d+)"/);
        if (!animeIdMatch) {
            throw new Error(`Could not find numeric anime ID on page for slug "${slug}"`);
        }
        const animeId = animeIdMatch[1];

        const { csrfToken, cookieHeader } = await this._getSession();

        const commonHeaders = {
            "X-Requested-With": "XMLHttpRequest",
            "X-CSRF-TOKEN": csrfToken,
            "Referer": `${this.baseUrl}/${slug}/`,
            "Cookie": cookieHeader,
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        };

        const firstRes = await fetch(`${this.baseUrl}/ajax/episodes/${animeId}/1`, {
            method: "POST",
            headers: commonHeaders,
            body: `_token=${encodeURIComponent(csrfToken)}`,
        });

        if (!firstRes.ok) {
            throw new Error(`Failed to fetch episodes (status ${firstRes.status})`);
        }

        const firstData = await firstRes.json() as {
            data: Array<{ id: number; number: number; title: string }>;
            last_page: number;
        };

        const episodes: EpisodeDetails[] = [];

        const pushPage = (items: Array<{ id: number; number: number; title: string }>) => {
            for (const item of items) {
                if (!Number.isInteger(item.number)) continue;
                episodes.push({
                    id: `${slug}::${item.number}`,
                    number: item.number,
                    url: `${this.baseUrl}/${slug}/${item.number}/`,
                    title: item.title || `Episodio ${item.number}`,
                });
            }
        };

        pushPage(firstData.data);

        if (firstData.last_page > 1) {
            const pageNums = Array.from({ length: firstData.last_page - 1 }, (_, i) => i + 2);
            const pageResults = await Promise.all(
                pageNums.map((p) =>
                    fetch(`${this.baseUrl}/ajax/episodes/${animeId}/${p}`, {
                        method: "POST",
                        headers: commonHeaders,
                        body: `_token=${encodeURIComponent(csrfToken)}`,
                    }).then((r) => r.json()),
                ),
            ) as Array<{ data: Array<{ id: number; number: number; title: string }> }>;

            for (const page of pageResults) {
                if (page && page.data) pushPage(page.data);
            }
        }

        if (episodes.length === 0) {
            throw new Error("No episodes found.");
        }

        episodes.sort((a, b) => a.number - b.number);
        return episodes;
    }

    // ---------------------------------------------------------------------------
    // findEpisodeServer
    // ---------------------------------------------------------------------------

    async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
        console.log("🔍 findEpisodeServer called for server:", _server);

        try {
            const parts = episode.id.split("::");
            if (parts.length !== 2) {
                throw new Error(`Invalid episode id format: "${episode.id}"`);
            }
            const slug = parts[0];
            const epNum = parts[1];
            if (!epNum || isNaN(Number(epNum))) {
                throw new Error(`Invalid episode number: "${epNum}"`);
            }

            const episodeUrl = `${this.baseUrl}/${slug}/${epNum}/`;

            // Obtener la página del episodio
            const res = await fetch(episodeUrl, {
                headers: {
                    "Referer": `${this.baseUrl}/${slug}/`,
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                },
            });

            if (!res.ok) {
                throw new Error(`Failed to fetch episode page (status ${res.status})`);
            }

            const html = await res.text();

            // -----------------------------------------------------------------
            // Lógica para Desu y Magi (usando video[N] y botones)
            // -----------------------------------------------------------------
            if (_server.toLowerCase() === "desu" || _server.toLowerCase() === "magi") {
                const videoRegex = /video\[(\d+)\]\s*=\s*'<iframe[^']*src="([^"]+)"[^']*>'/g;
                const iframes: Array<{ index: number; url: string }> = [];
                let m: RegExpExecArray | null;
                while ((m = videoRegex.exec(html)) !== null) {
                    iframes.push({ index: parseInt(m[1], 10), url: m[2] });
                }

                if (iframes.length === 0) {
                    throw new Error("No video sources found on episode page for Desu/Magi.");
                }

                const serverNameRegex = /id="btn-show-(\d+)"[^>]*>([^<]+)<\/a>/g;
                const serverNames: Record<number, string> = {};
                let sn: RegExpExecArray | null;
                while ((sn = serverNameRegex.exec(html)) !== null) {
                    serverNames[parseInt(sn[1], 10)] = sn[2].trim().toLowerCase();
                }

                let targetIframe = iframes[0];
                const serverLower = _server.toLowerCase();
                for (const iframe of iframes) {
                    const name = serverNames[iframe.index] || "";
                    if (name === serverLower) {
                        targetIframe = iframe;
                        break;
                    }
                }

                const iframeUrl = targetIframe.url;
                const serverName = serverNames[targetIframe.index] || _server;

                const playerRes = await fetch(iframeUrl, {
                    headers: {
                        "Referer": episodeUrl,
                        "Origin": this.baseUrl,
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    },
                });

                if (!playerRes.ok) {
                    throw new Error(`Failed to fetch player page (status ${playerRes.status})`);
                }

                const contentType = playerRes.headers["content-type"] || "";
                if (contentType.startsWith("video/") || /\.(m3u8|mp4|webm)(\?|$)/i.test(iframeUrl)) {
                    return {
                        server: serverName,
                        headers: {
                            "Referer": episodeUrl,
                            "Origin": this.baseUrl,
                        },
                        videoSources: [
                            {
                                url: iframeUrl,
                                type: iframeUrl.includes(".m3u8") ? "m3u8" : "mp4",
                                quality: "default",
                                subtitles: [],
                            },
                        ],
                    };
                }

                const playerHtml = await playerRes.text();
                let streamUrl = this._extractStreamFromPage(playerHtml, iframeUrl);

                if (!streamUrl) {
                    const fallbackMatch = playerHtml.match(/(https?:\/\/[^\s'"]+\.(?:m3u8|mp4|webm)[^\s'"]*)/i);
                    if (fallbackMatch && fallbackMatch[1]) {
                        streamUrl = fallbackMatch[1];
                    }
                }

                if (!streamUrl) {
                    throw new Error(`Could not extract video stream URL from player page for server "${serverName}".`);
                }

                console.log(`🎬 Extracted stream URL for ${_server}: ${streamUrl}`);
                const isM3u8 = /\.m3u8/i.test(streamUrl);
                return {
                    server: serverName,
                    headers: {
                        "Referer": iframeUrl,
                        "Origin": this.baseUrl,
                    },
                    videoSources: [
                        {
                            url: streamUrl,
                            type: isM3u8 ? "m3u8" : "mp4",
                            quality: "default",
                            subtitles: [],
                        },
                    ],
                };
            }

            // -----------------------------------------------------------------
            // Lógica para el resto de servidores (basada en player_conte)
            // -----------------------------------------------------------------

            const serverLower = _server.toLowerCase();
            // Verificar que el servidor está soportado (excluimos Mega, Streamtape, Doodstream, Desuka)
            if (!this.serverDomains[serverLower]) {
                throw new Error(`Server "${_server}" is not supported. Supported: ${Object.keys(this.serverDomains).join(", ")}`);
            }

            // Buscar el iframe con clase "player_conte"
            const playerConteRegex = /<iframe[^>]+class=["']player_conte["'][^>]+src=["']([^"']+)["']/i;
            const match = html.match(playerConteRegex);
            if (!match || !match[1]) {
                throw new Error("No player_conte iframe found on episode page.");
            }

            const iframeUrl = match[1];
            console.log(`🎯 Found player_conte iframe: ${iframeUrl}`);

            const urlObj = new URL(iframeUrl, this.baseUrl);
            const uParam = urlObj.searchParams.get('u');
            const eParam = urlObj.searchParams.get('e');

            // -----------------------------------------------------------------
            // Caso 1: Tiene 'u' → decodificar y seguir
            // -----------------------------------------------------------------
            if (uParam && uParam.length > 0) {
                console.log(`🔑 Found 'u' parameter: ${uParam}`);
                const base64 = uParam.replace(/-/g, '+').replace(/_/g, '/');
                const pad = base64.length % 4;
                const padded = pad ? base64 + '='.repeat(4 - pad) : base64;
                let decoded = '';
                if (typeof Buffer !== 'undefined') {
                    decoded = Buffer.from(padded, 'base64').toString('utf-8');
                } else {
                    decoded = atob(padded);
                }
                console.log(`🎬 Decoded URL: ${decoded}`);

                // Si es video directo, devolverlo
                if (/\.(m3u8|mp4|webm|mkv)(\?.*)?$/i.test(decoded)) {
                    return {
                        server: _server,
                        headers: { "Referer": iframeUrl, "Origin": this.baseUrl },
                        videoSources: [{ url: decoded, type: decoded.includes('.m3u8') ? "m3u8" : "mp4", quality: "default", subtitles: [] }],
                    };
                }

                // Fetch y buscar iframe del servidor (solo si el servidor tiene dominios definidos)
                const domains = this.serverDomains[serverLower] || [];
                const playerRes = await fetch(decoded, {
                    headers: { "Referer": episodeUrl, "User-Agent": "Mozilla/5.0 ...", "Origin": this.baseUrl },
                });
                if (!playerRes.ok) throw new Error(`Failed to fetch decoded URL (status ${playerRes.status})`);
                const playerHtml = await playerRes.text();

                // Buscar iframe con dominio del servidor
                const iframeRegex = /<iframe[^>]+src=["']([^"']+)["']/gi;
                let finalUrl: string | null = null;
                let iframeMatch;
                while ((iframeMatch = iframeRegex.exec(playerHtml)) !== null) {
                    const src = iframeMatch[1];
                    if (domains.some(d => src.toLowerCase().includes(d))) {
                        finalUrl = src;
                        break;
                    }
                }
                if (!finalUrl) {
                    const genericIframe = playerHtml.match(/<iframe[^>]+src=["']([^"']+)["']/i);
                    if (genericIframe && genericIframe[1] && !genericIframe[1].includes('nika.playmudos.com')) {
                        finalUrl = genericIframe[1];
                    }
                }
                if (!finalUrl) {
                    let streamUrl = this._extractStreamFromPage(playerHtml, decoded);
                    if (streamUrl && !streamUrl.includes('nika.playmudos.com')) {
                        console.log(`🎬 Extracted stream URL (fallback): ${streamUrl}`);
                        const isM3u8 = /\.m3u8/i.test(streamUrl);
                        return { server: _server, headers: { "Referer": decoded, "Origin": this.baseUrl }, videoSources: [{ url: streamUrl, type: isM3u8 ? "m3u8" : "mp4", quality: "default", subtitles: [] }] };
                    }
                    throw new Error(`No valid video URL found for ${_server}`);
                }
                if (!finalUrl.startsWith('http')) finalUrl = new URL(finalUrl, decoded).toString();
                console.log(`🎬 Final video URL: ${finalUrl}`);
                const isM3u8 = /\.m3u8/i.test(finalUrl);
                return { server: _server, headers: { "Referer": decoded, "Origin": this.baseUrl }, videoSources: [{ url: finalUrl, type: isM3u8 ? "m3u8" : "mp4", quality: "default", subtitles: [] }] };
            }

            // -----------------------------------------------------------------
            // Caso 2: Tiene 'e' → buscar enlace de descarga directa
            // -----------------------------------------------------------------
            if (eParam && eParam.length > 0) {
                console.log(`🔑 Found 'e' parameter, looking for download link`);

                // Buscar en el HTML el enlace de descarga para este servidor
                // La regex busca el nombre del servidor, luego "Descargar HD" y captura la URL
                const downloadRegex = new RegExp(
                    `${serverLower}[\\s\\S]*?Descargar\\s*HD[\\s\\S]*?href=["']([^"']+)["']`,
                    'i'
                );
                const downloadMatch = html.match(downloadRegex);
                if (downloadMatch && downloadMatch[1]) {
                    const directUrl = downloadMatch[1];
                    console.log(`🎬 Found direct download URL for ${_server}: ${directUrl}`);
                    let finalUrl = directUrl;
                    if (!finalUrl.startsWith('http')) {
                        finalUrl = new URL(finalUrl, this.baseUrl).toString();
                    }
                    const isM3u8 = /\.m3u8/i.test(finalUrl);
                    return {
                        server: _server,
                        headers: {
                            "Referer": episodeUrl,
                            "Origin": this.baseUrl,
                        },
                        videoSources: [
                            {
                                url: finalUrl,
                                type: isM3u8 ? "m3u8" : "mp4",
                                quality: "default",
                                subtitles: [],
                            },
                        ],
                    };
                }

                // Si no se encuentra el enlace de descarga, intentar extraer iframe del player
                console.log(`⚠️ No download link found, falling back to iframe extraction`);
                const playerRes = await fetch(iframeUrl, {
                    headers: { "Referer": episodeUrl, "Origin": this.baseUrl, "User-Agent": "Mozilla/5.0 ..." },
                });
                if (!playerRes.ok) throw new Error(`Failed to fetch player page (status ${playerRes.status})`);
                const playerHtml = await playerRes.text();

                // Buscar iframe con dominio del servidor
                const domains = this.serverDomains[serverLower] || [];
                const iframeRegex = /<iframe[^>]+src=["']([^"']+)["']/gi;
                let finalUrl: string | null = null;
                let iframeMatch;
                while ((iframeMatch = iframeRegex.exec(playerHtml)) !== null) {
                    const src = iframeMatch[1];
                    if (domains.some(d => src.toLowerCase().includes(d))) {
                        finalUrl = src;
                        break;
                    }
                }
                if (!finalUrl) {
                    const domainPattern = domains.map(d => d.replace(/\./g, '\\.')).join('|');
                    const urlRegex = new RegExp(`(https?://(?:${domainPattern})[^\\s'"]+)`, 'i');
                    const urlMatch = playerHtml.match(urlRegex);
                    if (urlMatch && urlMatch[1]) {
                        finalUrl = urlMatch[1];
                    }
                }
                if (!finalUrl) {
                    const genericIframe = playerHtml.match(/<iframe[^>]+src=["']([^"']+)["']/i);
                    if (genericIframe && genericIframe[1] && !genericIframe[1].includes('nika.playmudos.com')) {
                        finalUrl = genericIframe[1];
                    }
                }
                if (!finalUrl) {
                    let streamUrl = this._extractStreamFromPage(playerHtml, iframeUrl);
                    if (streamUrl && !streamUrl.includes('nika.playmudos.com')) {
                        console.log(`🎬 Extracted stream URL (fallback): ${streamUrl}`);
                        const isM3u8 = /\.m3u8/i.test(streamUrl);
                        return { server: _server, headers: { "Referer": iframeUrl, "Origin": this.baseUrl }, videoSources: [{ url: streamUrl, type: isM3u8 ? "m3u8" : "mp4", quality: "default", subtitles: [] }] };
                    }
                    throw new Error(`No valid video URL found for ${_server}`);
                }
                if (!finalUrl.startsWith('http')) finalUrl = new URL(finalUrl, iframeUrl).toString();
                console.log(`🎬 Final video URL: ${finalUrl}`);
                const isM3u8 = /\.m3u8/i.test(finalUrl);
                return { server: _server, headers: { "Referer": iframeUrl, "Origin": this.baseUrl }, videoSources: [{ url: finalUrl, type: isM3u8 ? "m3u8" : "mp4", quality: "default", subtitles: [] }] };
            }

            // -----------------------------------------------------------------
            // Caso 3: No tiene ni 'u' ni 'e' → error
            // -----------------------------------------------------------------
            throw new Error(`No 'u' or 'e' parameter found in player_conte iframe. URL: ${iframeUrl}`);

        } catch (error) {
            console.error(`❌ Error in findEpisodeServer for "${_server}":`, error);
            throw new Error(`findEpisodeServer failed for ${_server}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
} // <--- CIERRE DE LA CLASE

// Registrar la extensión si el entorno lo permite
if (typeof window !== "undefined" && (window as any).registerProvider) {
    (window as any).registerProvider(new Provider());
}