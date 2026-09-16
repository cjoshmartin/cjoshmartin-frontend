const RESUME_URL = 'https://raw.githubusercontent.com/cjoshmartin-com/resume/refs/heads/master/index.html'

const TOOLBAR = `
<style>
  #resume-toolbar {
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 2147483647;
    display: flex;
    gap: 8px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  #resume-toolbar button {
    cursor: pointer;
    padding: 8px 14px;
    font-size: 14px;
    border-radius: 6px;
    border: 1px solid #397249;
    background: #ffffff;
    color: #397249;
  }
  #resume-toolbar button:hover {
    background: #397249;
    color: #ffffff;
  }
  @media print {
    #resume-toolbar {
      display: none !important;
    }
  }
</style>
<div id="resume-toolbar">
  <button type="button" onclick="history.length > 1 ? history.back() : (location.href = '/')">&larr; Back</button>
  <button type="button" onclick="window.print()">Print</button>
</div>
`

function removePhoneNumber(html: string): string {
    return html.replace(
        /\s*<span>•<\/span>\s*<a href="tel:[^"]*">[^<]*<\/a>/i,
        ''
    )
}

function injectToolbar(html: string): string {
    if (html.includes('</body>')) {
        return html.replace('</body>', `${TOOLBAR}</body>`)
    }
    return html + TOOLBAR
}

export async function GET() {
    const res = await fetch(RESUME_URL, {
        next: { revalidate: 3600 },
    })

    if (!res.ok) {
        return new Response('Resume not found', { status: 502 })
    }

    const html = await res.text()
    const withoutPhone = removePhoneNumber(html)
    const withToolbar = injectToolbar(withoutPhone)

    return new Response(withToolbar, {
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
        },
    })
}
