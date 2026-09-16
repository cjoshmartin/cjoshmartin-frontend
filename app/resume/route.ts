import { getCleanResumeHtml, injectBeforeBodyEnd } from './_lib/resume'

const TOOLBAR = `
<style>
  * {
    box-sizing: border-box;
  }
  body {
    max-width: 100%;
    overflow-x: hidden;
  }
  body > div {
    width: 100%;
    padding: 0 1rem;
  }
  #resume-toolbar-wrap {
    position: sticky;
    left: 0;
    right: 0;
    bottom: 10px;
    z-index: 1;
    display: flex;
    justify-content: center;
    pointer-events: none;
  }
  #resume-toolbar {
    width: 100%;
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
    padding: 8px 1rem;
    pointer-events: auto;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  #resume-toolbar button,
  #resume-toolbar a {
    cursor: pointer;
    padding: 8px 14px;
    font-size: 14px;
    border-radius: 6px;
    border: 1px solid #397249;
    background: #ffffff;
    color: #397249;
    text-decoration: none;
    line-height: 1.2;
    display: inline-block;
  }
  #resume-toolbar button:hover,
  #resume-toolbar a:hover {
    background: #397249;
    color: #ffffff;
  }
  #resume-toolbar button:disabled {
    opacity: 0.6;
    cursor: default;
  }
  @media (max-width: 640px) {
    #resume-toolbar {
      justify-content: center;
      gap: 6px;
      padding: 6px;
    }
    #resume-toolbar button,
    #resume-toolbar a {
      padding: 6px 10px;
      font-size: 12px;
    }
  }
  @media print {
    #resume-toolbar-wrap {
      display: none !important;
    }
  }
</style>
<div id="resume-toolbar-wrap">
  <div id="resume-toolbar">
    <button type="button" onclick="history.length > 1 ? history.back() : (location.href = '/')">&larr; Back</button>
    <button type="button" onclick="window.print()">Print</button>
    <a href="/resume/pdf" target="_blank" rel="noopener noreferrer">&darr; Download PDF</a>
  </div>
</div>
`

export async function GET() {
    let html: string
    try {
        html = await getCleanResumeHtml()
    } catch {
        return new Response('Resume not found', { status: 502 })
    }

    const withToolbar = injectBeforeBodyEnd(html, TOOLBAR)

    return new Response(withToolbar, {
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
        },
    })
}
