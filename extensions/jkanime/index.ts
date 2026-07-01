/// <reference path="../../online-streaming-provider.d.ts" />

/**
 * JKAnime - Online Streaming Provider for jkanime.net
 *
 * Flow:
 *  1. search()         → POST /ajax_search with CSRF
 *  2. findEpisodes()   → POST /ajax/episodes/{animeId}/{page} with CSRF (paginated)
 *  3. findEpisodeServer() → 
 *      - Desu/Magi: native player logic (.m3u8 extraction)
 *      - Other servers: extracts the 'servers' array, decodes 'remote' (base64 URL),
 *        and runs it through the respective server extractor.
 */

// ---------------------------------------------------------------------------
// Shared User-Agent
// ---------------------------------------------------------------------------
const _UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

// ---------------------------------------------------------------------------
// Utility: base64 decode
// ---------------------------------------------------------------------------
function _b64decode(s: string): string {
    try {
        return atob(s)
    } catch (_) {
        const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="
        let output = ""
        let i = 0
        s = s.replace(/[^A-Za-z0-9+/=]/g, "")
        while (i < s.length) {
            const e1 = chars.indexOf(s[i++])
            const e2 = chars.indexOf(s[i++])
            const e3 = chars.indexOf(s[i++])
            const e4 = chars.indexOf(s[i++])
            output += String.fromCharCode((e1 << 2) | (e2 >> 4))
            if (e3 !== 64) output += String.fromCharCode(((e2 & 15) << 4) | (e3 >> 2))
            if (e4 !== 64) output += String.fromCharCode(((e3 & 3) << 6) | e4)
        }
        return output
    }
}

// ---------------------------------------------------------------------------
// Utility: Dean Edwards p,a,c,k,e,d JavaScript unpacker
// Used by Filemoon and optionally Streamwish/Vidhide/Mixdrop
// ---------------------------------------------------------------------------
function _unpackJS(packed: string): string {
    try {
        const fullMatch = packed.match(
            /eval\(function\(p,a,c,k,e,(?:d|r)\)\{.*?\}\('((?:[^'\\]|\\.)*)',(\d+),(\d+),'((?:[^'\\]|\\.)*)'(?:\.split\('(\|?)'\))?\)\)/s
        )
        if (!fullMatch) return packed

        const [, p, aStr, cStr, kStr, splitChar] = fullMatch
        const a = parseInt(aStr)
        const c = parseInt(cStr)
        const k: string[] = kStr.split(splitChar || "|")

        function d(b: number): string {
            const result = b < a ? "" : d(Math.floor(b / a))
            const rem = b % a
            return result + (rem > 35 ? String.fromCharCode(rem + 29) : rem.toString(36))
        }

        let unpacked = p
        for (let i = c - 1; i >= 0; i--) {
            if (k[i]) {
                const token = d(i)
                unpacked = unpacked.replace(
                    new RegExp("\\b" + token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "g"),
                    k[i]
                )
            }
        }
        return unpacked
    } catch (_) {
        return packed
    }
}

// ---------------------------------------------------------------------------
// Utility: random alphanumeric string
// ---------------------------------------------------------------------------
function _randomStr(n: number): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    let s = ""
    for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)]
    return s
}

// ---------------------------------------------------------------------------
// External server extractors
// ---------------------------------------------------------------------------

async function _extractStreamwish(embedUrl: string, serverLabel: string): Promise<EpisodeServer> {
    const origin = new URL(embedUrl).origin

    const res = await fetch(embedUrl, {
        headers: { "Referer": origin + "/", "User-Agent": _UA },
    })
    if (!res.ok) throw new Error(`${serverLabel}: HTTP ${res.status}`)

    let html = await (res as any).text()

    const packedBlock = html.match(/eval\(function\(p,a,c,k,e[,.](?:d|r)\)[\s\S]+?\)\)/)
    if (packedBlock) {
        try { html = html.replace(packedBlock[0], _unpackJS(packedBlock[0])) } catch (_) {}
    }

    const patterns = [
        /sources\s*:\s*\[\s*\{[^}]*file\s*:\s*["']([^"']+\.m3u8[^"']*)["']/,
        /file\s*:\s*["']([^"']+\.m3u8[^"']*)["']/,
        /"file"\s*:\s*"([^"]+\.m3u8[^"]*)"/,
        /["']([^"']+\.m3u8[^"']*)["']/,
    ]

    for (const p of patterns) {
        const m = html.match(p)
        if (m && m[1]) {
            return {
                server: serverLabel,
                headers: { "Referer": embedUrl, "Origin": origin },
                videoSources: [{ url: m[1], type: "m3u8", quality: "default", subtitles: [] }],
            }
        }
    }
    throw new Error(`${serverLabel}: could not extract m3u8 URL`)
}

async function _extractVOE(embedUrl: string): Promise<EpisodeServer> {
    const origin = new URL(embedUrl).origin

    const res = await fetch(embedUrl, {
        headers: { "Referer": origin + "/", "User-Agent": _UA },
    })
    if (!res.ok) throw new Error(`VOE: HTTP ${res.status}`)

    const html = await (res as any).text()

    const b64Patterns = [
        /(?:hls_p|'hls'|"hls")\s*[=:]\s*(?:atob\s*\(\s*)?['"]([A-Za-z0-9+/=]{20,})['"](?:\s*\))?/,
        /atob\s*\(\s*['"]([A-Za-z0-9+/=]{20,})['"]\s*\)/,
    ]

    for (const pattern of b64Patterns) {
        const m = html.match(pattern)
        if (m && m[1]) {
            try {
                const decoded = _b64decode(m[1])
                if (decoded.startsWith("http") && decoded.includes("m3u8")) {
                    return {
                        server: "VOE",
                        headers: { "Referer": embedUrl, "Origin": origin },
                        videoSources: [{ url: decoded, type: "m3u8", quality: "default", subtitles: [] }],
                    }
                }
            } catch (_) {}
        }
    }

    const direct = html.match(/["']([^"']+\.m3u8[^"']*)["']/)
    if (direct && direct[1]) {
        return {
            server: "VOE",
            headers: { "Referer": embedUrl, "Origin": origin },
            videoSources: [{ url: direct[1], type: "m3u8", quality: "default", subtitles: [] }],
        }
    }

    throw new Error("VOE: could not extract stream URL")
}

async function _extractFilemoon(embedUrl: string): Promise<EpisodeServer> {
    const origin = new URL(embedUrl).origin

    const res = await fetch(embedUrl, {
        headers: { "Referer": origin + "/", "User-Agent": _UA },
    })
    if (!res.ok) throw new Error(`Filemoon: HTTP ${res.status}`)

    let html = await (res as any).text()

    const packedAll = html.match(/eval\(function\(p,a,c,k,e[,.](?:d|r)\)[\s\S]+?\)\)/g)
    if (packedAll) {
        for (const block of packedAll) {
            try { html += "\n" + _unpackJS(block) } catch (_) {}
        }
    }

    const patterns = [
        /sources\s*:\s*\[\s*\{[^}]*file\s*:\s*["']([^"']+\.m3u8[^"']*)["']/,
        /file\s*:\s*["']([^"']+\.m3u8[^"']*)["']/,
        /"file"\s*:\s*"([^"]+\.m3u8[^"]*)"/,
        /["']([^"']+\.m3u8[^"']*)["']/,
    ]

    for (const p of patterns) {
        const m = html.match(p)
        if (m && m[1]) {
            return {
                server: "Filemoon",
                headers: { "Referer": embedUrl, "Origin": origin },
                videoSources: [{ url: m[1], type: "m3u8", quality: "default", subtitles: [] }],
            }
        }
    }
    throw new Error("Filemoon: could not extract m3u8 URL")
}

async function _extractMixdrop(embedUrl: string): Promise<EpisodeServer> {
    const origin = new URL(embedUrl).origin

    const res = await fetch(embedUrl, {
        headers: { "Referer": origin + "/", "User-Agent": _UA },
    })
    if (!res.ok) throw new Error(`Mixdrop: HTTP ${res.status}`)

    let html = await (res as any).text()

    const packedAll = html.match(/eval\(function\(p,a,c,k,e[,.](?:d|r)\)[\s\S]+?\)\)/g)
    if (packedAll) {
        for (const block of packedAll) {
            try { html += "\n" + _unpackJS(block) } catch (_) {}
        }
    }

    const wurlPatterns = [
        /MDCore\.wurl\s*=\s*["']([^"']+)["']/,
        /wurl\s*=\s*["']([^"']+\.mp4[^"']*)["']/,
        /["']([^"']*(?:\/m\/)[^"']+\.mp4[^"']*)["']/,
    ]

    for (const p of wurlPatterns) {
        const m = html.match(p)
        if (m && m[1]) {
            let url = m[1]
            if (url.startsWith("//")) url = "https:" + url
            return {
                server: "Mixdrop",
                headers: { "Referer": embedUrl, "Origin": origin },
                videoSources: [{ url, type: "mp4", quality: "default", subtitles: [] }],
            }
        }
    }
    throw new Error("Mixdrop: could not extract video URL")
}

async function _extractMp4upload(embedUrl: string): Promise<EpisodeServer> {
    const res = await fetch(embedUrl, {
        headers: { "Referer": "https://www.mp4upload.com/", "User-Agent": _UA },
    })
    if (!res.ok) throw new Error(`Mp4upload: HTTP ${res.status}`)

    const html = await (res as any).text()

    const patterns = [
        /file\s*:\s*["']([^"']+\.mp4[^"']*)["']/,
        /["']([^"']+mp4upload\.com[^"']+\.mp4[^"']*)["']/,
        /src\s*=\s*["']([^"']+\.mp4[^"']*)["']/,
    ]

    for (const p of patterns) {
        const m = html.match(p)
        if (m && m[1]) {
            return {
                server: "Mp4upload",
                headers: { "Referer": "https://www.mp4upload.com/" },
                videoSources: [{ url: m[1], type: "mp4", quality: "default", subtitles: [] }],
            }
        }
    }
    throw new Error("Mp4upload: could not extract video URL")
}

async function _extractStreamtape(embedUrl: string): Promise<EpisodeServer> {
    const origin = new URL(embedUrl).origin

    const res = await fetch(embedUrl, {
        headers: { "Referer": origin + "/", "User-Agent": _UA },
    })
    if (!res.ok) throw new Error(`Streamtape: HTTP ${res.status}`)

    const html = await (res as any).text()

    const twoPartRegex = /innerHTML\s*=\s*["']([^"']+)["']\s*\+\s*["']([^"']+)["']/g
    let mp: RegExpExecArray | null
    while ((mp = twoPartRegex.exec(html)) !== null) {
        const combined = (mp[1] + mp[2]).trim()
        if (combined.includes("get_video") || combined.includes("streamtape")) {
            const url = combined.startsWith("//") ? "https:" + combined : combined
            return {
                server: "Streamtape",
                headers: { "Referer": embedUrl },
                videoSources: [{ url, type: "mp4", quality: "default", subtitles: [] }],
            }
        }
    }

    const direct = html.match(/["'](\/\/[^"']*get_video[^"']*)["']/)
    if (direct && direct[1]) {
        return {
            server: "Streamtape",
            headers: { "Referer": embedUrl },
            videoSources: [{ url: "https:" + direct[1], type: "mp4", quality: "default", subtitles: [] }],
        }
    }

    throw new Error("Streamtape: could not reconstruct video URL")
}

async function _extractDoodstream(embedUrl: string): Promise<EpisodeServer> {
    const origin = new URL(embedUrl).origin

    const step1 = await fetch(embedUrl, {
        headers: { "Referer": origin + "/", "User-Agent": _UA },
    })
    if (!step1.ok) throw new Error(`Doodstream: HTTP ${step1.status} on embed page`)

    const html = await (step1 as any).text()

    const cookies = (step1 as any).cookies || {}
    const cookieHeader = Object.keys(cookies).map((k) => `${k}=${cookies[k]}`).join("; ")

    const passMd5Match = html.match(/\/pass_md5\/([^'"&\s]+)/)
    if (!passMd5Match) throw new Error("Doodstream: pass_md5 token not found")

    const passMd5Url = `${origin}/pass_md5/${passMd5Match[1]}`

    const step2 = await fetch(passMd5Url, {
        headers: { "Referer": embedUrl, "User-Agent": _UA, "Cookie": cookieHeader },
    })
    if (!step2.ok) throw new Error(`Doodstream: HTTP ${step2.status} on pass_md5`)

    const baseUrl = await (step2 as any).text()
    const trimmedBaseUrl = baseUrl.trim()
    if (!trimmedBaseUrl.startsWith("http")) throw new Error("Doodstream: invalid base URL from pass_md5")

    const rand = _randomStr(10)
    const expiry = Date.now()
    const finalUrl = `${trimmedBaseUrl}${rand}?token=${passMd5Match[1]}&expiry=${expiry}`

    return {
        server: "Doodstream",
        headers: { "Referer": embedUrl, "User-Agent": _UA },
        videoSources: [{ url: finalUrl, type: "mp4", quality: "default", subtitles: [] }],
    }
}

async function _extractMega(embedUrl: string): Promise<EpisodeServer> {
    let url = embedUrl
    if (!url.includes("/embed/")) {
        const hashMatch = url.match(/#!([^!]+)!(.+)/)
        if (hashMatch) url = `https://mega.nz/embed/${hashMatch[1]}#${hashMatch[2]}`
    }
    return {
        server: "Mega",
        headers: {},
        videoSources: [{ url, type: "unknown", quality: "default", subtitles: [] }],
    }
}

// ---------------------------------------------------------------------------
// Provider class
// ---------------------------------------------------------------------------
class Provider {

    baseUrl = "https://jkanime.net"

    serverDomains: Record<string, string[]> = {
        "mega": ["mega.nz", "mega.co.nz"],
        "streamwish": ["streamwish.com", "swish.to", "awish.pro", "streamwish.to", "sfastwish.com", "flaswish.com"],
        "voe": ["voe.sx", "voe.bar", "voe.gp", "jennifereconomicgive.com"],
        "vidhide": ["vidhide.com", "vidhidevip.com", "vidhidepro.com", "vidhide.at", "luluvdo.com"],
        "filemoon": ["filemoon.sx", "filemoon.to", "filemoon.in", "bysekoze.com"],
        "mixdrop": ["mixdrop.co", "mixdrop.top", "miixdrop.net", "mixdrop.ag", "mixdrop.bz"],
        "mp4upload": ["mp4upload.com"],
        "streamtape": ["streamtape.com", "streamtape.to", "streamtape.net"],
        "doodstream": ["doodstream.com", "dood.to", "dood.watch", "doods.pro", "doodstream.co"]
    }

    getSettings(): Settings {
        return {
            episodeServers: ["Desu", "Magi", "Mega", "Streamwish", "VOE", "Vidhide", "Filemoon", "Mixdrop", "Mp4upload", "Streamtape", "Doodstream"],
            supportsDub: true,
        }
    }

    async _getSession(): Promise<{ csrfToken: string; cookieHeader: string }> {
        const res = await fetch(this.baseUrl, {
            headers: { "User-Agent": _UA },
        })

        const html = await (res as any).text()
        const csrfMatch = html.match(/<meta name="csrf-token" content="([^"]+)"/)
        const csrfToken = csrfMatch ? csrfMatch[1] : ""

        const cookies = (res as any).cookies || {}
        const cookieHeader = Object.keys(cookies)
            .map((k) => `${k}=${cookies[k]}`)
            .join("; ")

        return { csrfToken, cookieHeader }
    }

    _normalise(s: string): string {
        return s
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, " ")
            .replace(/\s+/g, " ")
            .trim()
    }

    _similarity(query: string, candidate: string): number {
        const qWords = this._normalise(query).split(" ")
        const cNorm = this._normalise(candidate)
        const matches = qWords.filter((w) => cNorm.includes(w)).length
        return matches / qWords.length
    }

    _extractStreamFromPage(html: string, iframeUrl: string): string {
        if (/\.(m3u8|mp4|webm|mkv)(\?.*)?$/i.test(iframeUrl)) {
            return iframeUrl
        }

        const nestedIframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i)
        if (nestedIframeMatch && nestedIframeMatch[1]) {
            const nestedUrl = nestedIframeMatch[1]
            if (/\.(m3u8|mp4|webm)(\?.*)?$/i.test(nestedUrl)) {
                return nestedUrl
            }
            return nestedUrl
        }

        const patterns = [
            /(?:file|src|video_url|source|url)\s*[:=]\s*["']([^"']+\.(?:m3u8|mp4|webm)[^"']*)["']/i,
            /<source\s+src=["']([^"']+\.(?:m3u8|mp4|webm)[^"']*)["']/i,
            /hls\.loadSource\(\s*["']([^"']+\.m3u8[^"']*)["']\s*\)/i,
            /src=["']([^"']+\.(?:m3u8|mp4|webm)[^"']*)["']/i,
            /["']file["']\s*:\s*["']([^"']+)["']/i,
            /["']url["']\s*:\s*["']([^"']+)["']/i,
        ]

        for (const p of patterns) {
            const m = html.match(p)
            if (m && m[1]) {
                let streamUrl = m[1]
                if (streamUrl.startsWith("//")) {
                    streamUrl = "https:" + streamUrl
                }
                return streamUrl
            }
        }
        return ""
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const { csrfToken, cookieHeader } = await this._getSession()

        const res = await fetch(`${this.baseUrl}/ajax_search`, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "X-Requested-With": "XMLHttpRequest",
                "X-CSRF-TOKEN": csrfToken,
                "Referer": this.baseUrl,
                "Cookie": cookieHeader,
                "User-Agent": _UA,
            },
            body: `q=${encodeURIComponent(opts.query)}`,
        })

        if (!res.ok) {
            return []
        }

        let data: any[]
        try {
            data = await (res as any).json()
        } catch (_) {
            return []
        }

        if (!Array.isArray(data)) {
            return []
        }

        const results: SearchResult[] = data.map((item: any) => ({
            id: item.slug,
            title: item.title,
            url: `${this.baseUrl}/${item.slug}/`,
            subOrDub: "sub" as SubOrDub,
        }))

        results.sort((a, b) => this._similarity(opts.query, b.title) - this._similarity(opts.query, a.title))

        return results
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const slug = id

        const animePageRes = await fetch(`${this.baseUrl}/${slug}/`, {
            headers: { "User-Agent": _UA },
        })

        if (!animePageRes.ok) {
            throw new Error(`Anime page not found for slug "${slug}" (status ${animePageRes.status})`)
        }

        const animeHtml = await (animePageRes as any).text()

        const animeIdMatch = animeHtml.match(/data-anime="(\d+)"/)
        if (!animeIdMatch) {
            throw new Error(`Could not find numeric anime ID on page for slug "${slug}"`)
        }
        const animeId = animeIdMatch[1]

        const { csrfToken, cookieHeader } = await this._getSession()

        const commonHeaders = {
            "X-Requested-With": "XMLHttpRequest",
            "X-CSRF-TOKEN": csrfToken,
            "Referer": `${this.baseUrl}/${slug}/`,
            "Cookie": cookieHeader,
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": _UA,
        }

        const firstRes = await fetch(`${this.baseUrl}/ajax/episodes/${animeId}/1`, {
            method: "POST",
            headers: commonHeaders,
            body: `_token=${encodeURIComponent(csrfToken)}`,
        })

        if (!firstRes.ok) {
            throw new Error(`Failed to fetch episodes (status ${firstRes.status})`)
        }

        const firstData = await (firstRes as any).json() as {
            data: Array<{ id: number; number: number; title: string }>
            last_page: number
        }

        const episodes: EpisodeDetails[] = []

        const pushPage = (items: Array<{ id: number; number: number; title: string }>) => {
            for (const item of items) {
                if (!Number.isInteger(item.number)) continue
                episodes.push({
                    id: `${slug}::${item.number}`,
                    number: item.number,
                    url: `${this.baseUrl}/${slug}/${item.number}/`,
                    title: item.title || `Episodio ${item.number}`,
                })
            }
        }

        pushPage(firstData.data)

        if (firstData.last_page > 1) {
            const pageNums = Array.from({ length: firstData.last_page - 1 }, (_, i) => i + 2)
            const pageResults = await Promise.all(
                pageNums.map((p) =>
                    fetch(`${this.baseUrl}/ajax/episodes/${animeId}/${p}`, {
                        method: "POST",
                        headers: commonHeaders,
                        body: `_token=${encodeURIComponent(csrfToken)}`,
                    }).then((r) => (r as any).json()),
                ),
            ) as Array<{ data: Array<{ id: number; number: number; title: string }> }>

            for (const page of pageResults) {
                if (page && page.data) pushPage(page.data)
            }
        }

        if (episodes.length === 0) {
            throw new Error("No episodes found.")
        }

        episodes.sort((a, b) => a.number - b.number)

        return episodes
    }

    async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
        console.log("🔍 findEpisodeServer called for server:", _server)

        try {
            const parts = episode.id.split("::")
            if (parts.length !== 2) {
                throw new Error(`Invalid episode id format: "${episode.id}"`)
            }
            const slug = parts[0]
            const epNum = parts[1]
            if (!epNum || isNaN(Number(epNum))) {
                throw new Error(`Invalid episode number: "${epNum}"`)
            }

            const episodeUrl = `${this.baseUrl}/${slug}/${epNum}/`

            const res = await fetch(episodeUrl, {
                headers: {
                    "Referer": `${this.baseUrl}/${slug}/`,
                    "User-Agent": _UA,
                },
            })

            if (!res.ok) {
                throw new Error(`Failed to fetch episode page (status ${res.status})`)
            }

            const html = await (res as any).text()

            if (_server.toLowerCase() === "desu" || _server.toLowerCase() === "magi") {
                const videoRegex = /video\[(\d+)\]\s*=\s*'<iframe[^']*src="([^"]+)"[^']*>'/g
                const iframes: Array<{ index: number; url: string }> = []
                let m: RegExpExecArray | null
                while ((m = videoRegex.exec(html)) !== null) {
                    iframes.push({ index: parseInt(m[1], 10), url: m[2] })
                }

                if (iframes.length === 0) {
                    throw new Error("No video sources found on episode page for Desu/Magi.")
                }

                const serverNameRegex = /id="btn-show-(\d+)"[^>]*>([^<]+)<\/a>/g
                const serverNames: Record<number, string> = {}
                let sn: RegExpExecArray | null
                while ((sn = serverNameRegex.exec(html)) !== null) {
                    serverNames[parseInt(sn[1], 10)] = sn[2].trim().toLowerCase()
                }

                let targetIframe = iframes[0]
                const serverLower = _server.toLowerCase()
                for (const iframe of iframes) {
                    const name = serverNames[iframe.index] || ""
                    if (name === serverLower) {
                        targetIframe = iframe
                        break
                    }
                }

                const iframeUrl = targetIframe.url
                const serverName = serverNames[targetIframe.index] || _server

                const playerRes = await fetch(iframeUrl, {
                    headers: {
                        "Referer": episodeUrl,
                        "Origin": this.baseUrl,
                        "User-Agent": _UA,
                    },
                })

                if (!playerRes.ok) {
                    throw new Error(`Failed to fetch player page (status ${playerRes.status})`)
                }

                const contentType = (playerRes as any).headers["content-type"] || ""
                if (contentType.startsWith("video/") || /\.(m3u8|mp4|webm)(\?.*)?$/i.test(iframeUrl)) {
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
                    }
                }

                const playerHtml = await (playerRes as any).text()
                let streamUrl = this._extractStreamFromPage(playerHtml, iframeUrl)

                if (!streamUrl) {
                    const fallbackMatch = playerHtml.match(/(https?:\/\/[^\s'"]+\.(?:m3u8|mp4|webm)[^\s'"]*)/i)
                    if (fallbackMatch && fallbackMatch[1]) {
                        streamUrl = fallbackMatch[1]
                    }
                }

                if (!streamUrl) {
                    throw new Error(`Could not extract video stream URL from player page for server "${serverName}".`)
                }

                console.log(`🎬 Extracted stream URL for ${_server}: ${streamUrl}`)
                const isM3u8 = /\.m3u8/i.test(streamUrl)
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
                }
            }

            const serverLower = _server.toLowerCase()
            if (!this.serverDomains[serverLower]) {
                throw new Error(`Server "${_server}" is not supported. Supported: ${Object.keys(this.serverDomains).join(", ")}`)
            }

            const serversRegex = /var\s+servers\s*=\s*(\[[\s\S]*?\]);/
            const serversMatch = html.match(serversRegex)
            if (!serversMatch || !serversMatch[1]) {
                throw new Error("Could not find servers array in HTML.")
            }

            let serversData: any[]
            try {
                const jsonStr = serversMatch[1]
                    .replace(/'/g, '"')
                    .replace(/([{,]\s*)(\w+):/g, '$1"$2":')
                serversData = JSON.parse(jsonStr)
            } catch (e: any) {
                throw new Error(`Failed to parse servers array: ${e.message}`)
            }

            const serverEntry = serversData.find((s: any) => 
                s.server && s.server.toLowerCase() === serverLower
            )
            if (!serverEntry) {
                throw new Error(`Server "${_server}" not found in servers array.`)
            }

            const remoteBase64 = serverEntry.remote
            if (!remoteBase64) {
                throw new Error(`No 'remote' field for server "${_server}".`)
            }

            const base64 = remoteBase64.replace(/-/g, '+').replace(/_/g, '/')
            const pad = base64.length % 4
            const padded = pad ? base64 + '='.repeat(4 - pad) : base64
            const embedUrl = _b64decode(padded)

            console.log(`🎬 Decoded remote URL for ${_server}: ${embedUrl}`)

            switch (serverLower) {
                case "mega":
                    return await _extractMega(embedUrl)
                case "streamwish":
                    return await _extractStreamwish(embedUrl, "Streamwish")
                case "voe":
                    return await _extractVOE(embedUrl)
                case "vidhide":
                    return await _extractStreamwish(embedUrl, "Vidhide")
                case "filemoon":
                    return await _extractFilemoon(embedUrl)
                case "mixdrop":
                    return await _extractMixdrop(embedUrl)
                case "mp4upload":
                    return await _extractMp4upload(embedUrl)
                case "streamtape":
                    return await _extractStreamtape(embedUrl)
                case "doodstream":
                    return await _extractDoodstream(embedUrl)
                default:
                    throw new Error(`Unhandled server: ${_server}`)
            }

        } catch (error) {
            console.error(`❌ Error in findEpisodeServer for "${_server}":`, error)
            throw new Error(`findEpisodeServer failed for ${_server}: ${error instanceof Error ? error.message : String(error)}`)
        }
    }
}

if (typeof window !== "undefined" && (window as any).registerProvider) {
    (window as any).registerProvider(new Provider())
}