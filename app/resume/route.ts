const RESUME_URL = 'https://raw.githubusercontent.com/cjoshmartin-com/resume/refs/heads/master/index.html'

const VIEWPORT_META = '<meta name="viewport" content="width=device-width, initial-scale=1">'

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
    <button type="button" id="resume-download-btn">&darr; Download PDF</button>
  </div>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"></script>
<script>
(function () {
  var btn = document.getElementById('resume-download-btn');
  var toolbar = document.getElementById('resume-toolbar-wrap');
  if (!btn || !toolbar) return;

  btn.addEventListener('click', function () {
    if (typeof html2pdf === 'undefined') {
      window.print();
      return;
    }

    var originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Preparing…';
    toolbar.style.display = 'none';

    var restore = function () {
      toolbar.style.display = '';
      btn.disabled = false;
      btn.textContent = originalLabel;
    };

    html2pdf()
      .set({
        filename: 'Josh-Martin-Resume.pdf',
        margin: 0.4,
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' },
      })
      .from(document.body)
      .save()
      .then(restore)
      .catch(function () {
        restore();
        window.print();
      });
  });
})();
</script>
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

function injectViewportMeta(html: string): string {
    if (html.includes('name="viewport"')) {
        return html
    }
    if (html.includes('<head>')) {
        return html.replace('<head>', `<head>\n${VIEWPORT_META}`)
    }
    return html.replace('<head', `${VIEWPORT_META}\n<head`)
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
    const withViewport = injectViewportMeta(withoutPhone)
    const withToolbar = injectToolbar(withViewport)

    return new Response(withToolbar, {
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
        },
    })
}
