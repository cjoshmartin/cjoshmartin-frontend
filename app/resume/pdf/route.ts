import { getCleanResumeHtml, injectBeforeBodyEnd } from '../_lib/resume'

const DOWNLOAD_PROMPT = `
<style>
  #pdf-bar {
    position: fixed;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 2147483647;
    display: flex;
    align-items: center;
    gap: 10px;
    background: #397249;
    color: #ffffff;
    padding: 10px 14px;
    border-radius: 6px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 14px;
    max-width: calc(100% - 32px);
  }
  #pdf-bar a {
    color: #ffffff;
    text-decoration: underline;
  }
  #pdf-bar button {
    cursor: pointer;
    padding: 6px 12px;
    font-size: 14px;
    border-radius: 6px;
    border: 1px solid #ffffff;
    background: #ffffff;
    color: #397249;
    white-space: nowrap;
  }
  #pdf-bar button:disabled {
    opacity: 0.6;
    cursor: default;
  }
  @media print {
    #pdf-bar {
      display: none !important;
    }
  }
</style>
<div id="pdf-bar">
  <span id="pdf-bar-label">Click to download your PDF</span>
  <button type="button" id="pdf-download-btn">&darr; Download PDF</button>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"></script>
<script>
(function () {
  var bar = document.getElementById('pdf-bar');
  var label = document.getElementById('pdf-bar-label');
  var btn = document.getElementById('pdf-download-btn');
  if (!bar || !label || !btn) return;

  btn.addEventListener('click', function () {
    if (typeof html2pdf === 'undefined') {
      label.textContent = "Couldn't load the PDF generator — opening the print dialog instead.";
      window.print();
      return;
    }

    btn.disabled = true;
    label.textContent = 'Preparing your PDF…';
    bar.style.display = 'none';

    html2pdf()
      .set({
        filename: 'Josh-Martin-Resume.pdf',
        margin: 0.4,
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' },
      })
      .from(document.body)
      .save()
      .then(function () {
        bar.style.display = '';
        btn.style.display = 'none';
        label.innerHTML = 'Your download has started. You can close this tab, or <a href="/resume">view the resume</a>.';
      })
      .catch(function () {
        bar.style.display = '';
        btn.disabled = false;
        label.textContent = 'Something went wrong generating the PDF — opening the print dialog instead.';
        window.print();
      });
  });
})();
</script>
`

export async function GET() {
    let html: string
    try {
        html = await getCleanResumeHtml()
    } catch {
        return new Response('Resume not found', { status: 502 })
    }

    const withDownload = injectBeforeBodyEnd(html, DOWNLOAD_PROMPT)

    return new Response(withDownload, {
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
        },
    })
}
