// this is a next.js page using the app router


export async function generateMetadata() {
  return {
    title: "Settings",
    description: "Settings",
    itunes: {
      appId: "6748627407",
      appArgument: "https://cjoshmartin.com/settings"
    },
  };
}

export default function SettingsPage() {
  return <div>
    <h1>Settings</h1>
  </div>;
}