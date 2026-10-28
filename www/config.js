// Connect Selah to your Supabase project (see README.md, "Turn on accounts").
// Leave these empty to run the demo with sample people instead.
window.SELAH_CONFIG = {
  supabaseUrl: "https://oawqimmgdxntijrgdoef.supabase.co",
  supabaseAnonKey: "sb_publishable_oZyEyVd73fOyaKTT-uVIow_1xE5tpp-",  // publishable key: safe to include in the app
  siteUrl: "http://localhost:8080",  // change to the web address once the app is online (also in Supabase › Authentication › URL Configuration)
  vapidPublicKey: "",   // for notifications in the web version (README, "Turn on push notifications")
  androidPush: false    // set to true after adding android/app/google-services.json (README, "Turn on push notifications")
};
