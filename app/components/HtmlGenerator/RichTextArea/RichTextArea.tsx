import { JSDOM } from 'jsdom';

// Function to add IDs to header tags in HTML content
function addIdsToHeaders(htmlContent: string): string {
    
    // Create a temporary DOM element to parse and manipulate the HTML
    const {window} = new JSDOM(htmlContent);
    const tempDiv = window.document.createElement('div');
    tempDiv.innerHTML = htmlContent;
    
    // Find all header tags and add IDs
    const headers = tempDiv.querySelectorAll('h1, h2, h3, h4, h5, h6');
    headers.forEach((header: any, index: number) => {
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
        }
    });
    
    return tempDiv.innerHTML;
}

export function RichTextArea({value, className}: any){
    // Process the HTML content to add IDs to headers
    const processedValue = addIdsToHeaders(value);
    
    return (
      <div className={className} dangerouslySetInnerHTML={{ __html: processedValue }} />
    );
}