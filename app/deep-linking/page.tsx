
// this a next.js page using the app router

export async function generateMetadata() {
  return {
    title: "Deep Linking",
    description: "Deep Linking",
    itunes: {
      appId: "6748627407",
      appArgument: "https://cjoshmartin.com/blog/deep-linking"
    },
  };
}

export default function DeepLinkingPage() {
  return <div>
    <h1>Deep Linking</h1>
    <p>
      This is a deep linking page.
    </p>
  </div>;
}