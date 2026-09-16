const RESUME_URL = 'https://raw.githubusercontent.com/cjoshmartin-com/resume/refs/heads/master/index.html'

const VIEWPORT_META = '<meta name="viewport" content="width=device-width, initial-scale=1">'

function removePhoneNumber(html: string): string {
    return html.replace(
        /\s*<span>•<\/span>\s*<a href="tel:[^"]*">[^<]*<\/a>/i,
        ''
    )
}

function injectViewportMeta(html: string): string {
    if (html.includes('name="viewport"')) {
        return html
    }
    if (html.includes('<head>')) {
        return html.replace('<head>', `<head>\n${VIEWPORT_META}`)
    }
    return html.replace('<head', `${VIEWPORT_META}\n<head`)
}

export async function getCleanResumeHtml(): Promise<string> {
    const res = await fetch(RESUME_URL, {
        next: { revalidate: 3600 },
    })

    if (!res.ok) {
        throw new Error(`Failed to fetch resume: ${res.status}`)
    }

    const html = await res.text()
    return injectViewportMeta(removePhoneNumber(html))
}

export function injectBeforeBodyEnd(html: string, snippet: string): string {
    if (html.includes('</body>')) {
        return html.replace('</body>', `${snippet}</body>`)
    }
    return html + snippet
}
