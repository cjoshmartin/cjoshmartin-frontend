import { JSDOM } from 'jsdom';

// Function to add IDs to header tags in HTML content
function addIdsToHeaders(htmlContent: string): string {
    
    // Create a temporary DOM element to parse and manipulate the HTML
    const {window} = new JSDOM(htmlContent);
    const {document} = window;
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = htmlContent;
    
    // Find all header tags and add IDs
    const headers: NodeListOf<Element> = tempDiv.querySelectorAll('h1, h2, h3, h4, h5, h6');
    const headerIds: string[] = [];
    headers.forEach((header: Element, index: number) => {
        if (!header.id) {
            // Generate an ID based on the header text and index
            const text = header.textContent || '';
            const sanitizedText = text
                .toLowerCase()
                .replace(/[^a-z0-9\s-]/g, '') // Remove special characters
                .replace(/\s+/g, '-') // Replace spaces with hyphens
                .trim();
            
            const id = sanitizedText || `header-${index + 1}`;
            header.id = id;
            headerIds.push(id);
        }
    });

    // After IDs are added, wrap each header in a link to its own ID
    const headersWithId: NodeListOf<Element> = tempDiv.querySelectorAll('h1, h2, h3, h4, h5, h6');
    headersWithId.forEach((header: Element) => {
        if (header.id && !header.querySelector('a')) {
            const anchor = document.createElement('a');
            anchor.href = `#${header.id}`;
            
            // Add a clickable anchor link to each header for copying its ID to clipboard
            anchor.style.cursor = 'pointer';
            anchor.style.textDecoration = 'none';
            anchor.style.marginLeft = '0.5em';
            anchor.style.color = 'inherit';
            anchor.classList.add('anchor-link');
            
            // Move all child nodes of the header into the anchor
            while (header.firstChild) {
                anchor.appendChild(header.firstChild);
            }
            header.appendChild(anchor);
        }
    });

    // position the header to the top of the page when it is targetted
    const headerStyleSheet = document.createElement('style');
    headerStyleSheet.textContent = `
        ${headerIds.map((id) => `#${id}:target {
            padding-top: 100px; 
            margin-top: -100px
        }`).join('\n')}
    `;
    tempDiv.appendChild(headerStyleSheet);
    return tempDiv.innerHTML;
}

export function RichTextArea({value, className}: any){
    // Process the HTML content to add IDs to headers
    const processedValue = addIdsToHeaders(value);
    
    return (
      <div className={className} dangerouslySetInnerHTML={{ __html: processedValue }} />
    );
}