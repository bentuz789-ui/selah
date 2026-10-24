# Selah

A faith-centered social app: a photo feed, stories, Looking Glass (disappearing photos), groups, direct messages, a prayer wall, and a Bible reader with highlights and reading streaks.

Selah runs in two modes:

- **Demo mode** (the default): sample people and posts, saved only on the device. Good for trying the app and showing it to people.
- **Live mode**: real accounts, with everything stored on a [Supabase](https://supabase.com) server so friends see each other's posts, messages and Looking Glasses. Turn it on with the steps in [Turn on accounts](#turn-on-accounts).

One codebase in `www/` runs three ways:

| Target | How |
|---|---|
| Web app (installable to a home screen) | Host the `www/` folder on any static web host |
| Android app | `android/` project, built with Android Studio |
| iPhone app | `ios/` project, built with Xcode on a Mac |

The native apps use [Capacitor](https://capacitorjs.com) 8, which wraps the web app in a native shell.

## Project layout

```
www/                  the app itself (edit here)
  index.html          all screens, styles and logic
  live.js             accounts and the connection to the server (live mode)
  config.js           your Supabase project address and key (empty = demo mode)
  vendor/supabase.js  the Supabase library
  bible/              the complete Bible in three translations (see below)
  fonts/              bundled fonts, so it works offline
  icons/              web app icons
  manifest.webmanifest, sw.js   install + offline support for the web version
resources/            source images for native icons and splash screens
android/, ios/        generated native projects (with camera/photo permissions added)
capacitor.config.json app id, name and splash settings
supabase/
  migrations/         the database: tables, security rules, notifications, photo storage, push devices
  functions/push/     the server function that sends push notifications
  seed.sql            starter groups
tests/security.test.mjs   checks the security rules with three test accounts
tests/push.test.mjs       checks push delivery against fake Apple/Google/browser services (tests/push-mock/)
```

## Bible text

`www/bible/` holds the complete Bible (66 books, 31,102 verses) in three public-domain translations:

| Folder | Translation | Source |
|---|---|---|
| `kjv/` | King James Version (1769) | [aruljohn/Bible-kjv](https://github.com/aruljohn/Bible-kjv) |
| `bsb/` | Berean Standard Bible | [scrollmapper/bible_databases](https://github.com/scrollmapper/bible_databases) |
| `asv/` | American Standard Version (1901) | [scrollmapper/bible_databases](https://github.com/scrollmapper/bible_databases) |

`books.json` lists the books in order with their chapter counts. Each translation has one file per book, numbered 1 (Genesis) to 66 (Revelation). Each file is a list of chapters, and each chapter is a list of verse texts. An empty verse is one the translation leaves out because it isn't in the earliest manuscripts, such as Matthew 17:21 in the BSB.

The app only loads a book when you open it. The phone apps include every book, so the whole Bible works offline. The web version saves each book for offline use after you open it once.

**Search.** The Search button on the Bible tab finds whole words or exact phrases (in quotes) in the translation you're reading, and jumps to references like `John 3:16`, `jn 3` or `1 cor 13`. The first search loads the whole translation, about 4 MB on the web version.

To add another public-domain translation, make a folder in the same format and add it to `TRANSLATIONS` near the top of the script in `index.html`.

## Turn on accounts

Live mode uses Supabase for accounts, the database, photo storage and live updates. It has a free plan that's plenty to start with. You don't run a server yourself.

### 1. Create a Supabase project

1. Sign up at [supabase.com](https://supabase.com) and click **New project**.
2. Name it `Selah`, choose a strong database password (save it somewhere safe), and pick the region closest to your church.
3. Wait a minute or two while it sets up.

### 2. Create the database

1. In your project, open **SQL Editor** and click **New query**.
2. Open `supabase/migrations/20261024000000_selah.sql` from this project, copy everything in it, paste it in, and click **Run**. You should see "Success. No rows returned."
3. Do the same with `supabase/migrations/20261025000000_push.sql` (push notifications).
4. Make another new query with the contents of `supabase/seed.sql` and run it. This adds five starter groups. Edit the names first if you like, or rename them later in **Table Editor › groups**.

If you're comfortable with a terminal, you can do the same with `npx supabase login`, `npx supabase link`, then `npx supabase db push`.

### 3. Set up sign-in emails

In **Authentication › URL Configuration**:

- Set **Site URL** to where your web version lives, like `https://selah.yourchurch.org`. Links in sign-up and password-reset emails go there. While testing, `http://localhost:8080` works.
- Under **Redirect URLs**, add the same address.

Supabase asks new people to confirm their email by default. Keep that on. Its built-in email service only sends a few emails an hour, so before launch, connect your own email provider under **Authentication › Emails › SMTP Settings** (Resend, Postmark and SendGrid all work).

### 4. Connect the app

1. In **Project Settings › API Keys**, copy the **publishable** key (older projects call it the **anon public** key). In **Project Settings › Data API**, copy the **Project URL**.
2. Put them in `www/config.js`:

   ```js
   window.SELAH_CONFIG = {
     supabaseUrl: "https://abcdefghij.supabase.co",
     supabaseAnonKey: "your publishable key",
     siteUrl: "https://selah.yourchurch.org"
   };
   ```

   The publishable key is meant to be in the app. The security rules in the database decide what each person can see. **Never** put the `service_role` or secret key in the app.
3. Run `npm start` and open http://localhost:8080. You'll see the welcome screen. Create an account, then create a second one in a private window and add each other as friends.
4. Run `npm run sync` to copy the change into the phone apps.

### What live mode includes

- Sign up with name, username, email and password; must confirm they're 13 or older and agree to the community guidelines. Log in, log out, reset a forgotten password by email, and delete the account from Settings.
- Friend requests. Posts, stories, prayer requests and messages are shared with friends; group posts are visible to everyone signed in.
- Photos for posts, stories, profile pictures and Looking Glasses are stored in Supabase Storage. A Looking Glass's photo and words can only be opened once by the person it was sent to, then they're deleted.
- Live updates: new messages, friend requests, likes, comments and prayers arrive while the app is open, with banners and the bell count. With [push notifications](#turn-on-push-notifications) set up, they also arrive when the app is closed.
- Anyone can create a group and becomes its admin. Admins can add events.
- Report and block work on the server: blocked people can't see your things, find you, or message you, and blocking ends the friendship.
- Your Bible highlights, reading progress, streak and settings are saved to your account, so they follow you to a new phone.

### Moderating

Reports arrive in **Table Editor › reports**, with the reason, what was reported and who reported it. To act on one:

- **Remove content**: delete the row in `posts`, `comments`, `stories` or `prayers` (the report's `post_id`, `comment_id` or `prayer_id` tells you which).
- **Suspend someone**: in **Authentication › Users**, find them and choose **Ban user**.
- Set the report's `status` to `reviewed` or `action_taken` so your team knows it's handled.

To make someone an admin of a group (so they can add events), run this in the SQL Editor:

```sql
update group_members set role = 'admin'
where group_id = (select id from groups where name = 'Youth Group')
  and user_id = (select id from profiles where username = 'their_username');
```

### Cost

The free plan includes a 500 MB database, 1 GB of photo storage and up to 50,000 monthly active users, which covers a church community for a long time. Free projects pause after a week with no activity, so once real people use the app, upgrade to the Pro plan ($25 a month). Check [supabase.com/pricing](https://supabase.com/pricing) for current limits.

### Testing changes to the database

With [Docker](https://www.docker.com/products/docker-desktop/) installed you can run a private copy of Supabase on your computer:

```bash
npx supabase start          # first run downloads a few GB
node tests/security.test.mjs   # 33 checks that people can only see what they should
```

`npx supabase start` prints a local API URL and anon key; put those in `www/config.js` to try the app against your local copy. Put your real project's values back before you ship.

## Turn on push notifications

Push notifications reach people when Selah is closed: new messages, Looking Glasses, friend requests, likes, comments and prayers. Turn on accounts first.

How it works: whenever the database creates a notification, it calls a small server function called `push` (`supabase/functions/push/index.ts`). The function sends it to each of the person's devices:

| Device | Sent through | You need |
|---|---|---|
| iPhone app | Apple Push Notification service | An Apple Developer account and a push key |
| Android app | Firebase Cloud Messaging | A free Firebase project |
| Web version | The browser's push service | A pair of VAPID keys (free, made with one command) |

Set up only the ones you need. The others are skipped.

### 1. Put the push function on your server

In a terminal in this project folder:

```bash
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF     # Project Settings › General › Project ID
npx supabase functions deploy push --no-verify-jwt
```

`--no-verify-jwt` is right here: the database, not a signed-in person, calls this function. It checks its own secret instead (next step).

### 2. Connect the database to it

1. Make a long random secret, like a 40-character password from a password manager.
2. In the Supabase dashboard, open **Edge Functions › Secrets** and add `PUSH_WEBHOOK_SECRET` with that value.
3. In **SQL Editor**, run this with your project id and the same secret:

   ```sql
   insert into private.push_settings (function_url, secret)
   values ('https://YOUR_PROJECT_REF.supabase.co/functions/v1/push', 'your-secret');
   ```

### 3. Web version

1. Run `npx web-push generate-vapid-keys`. It prints a public and a private key.
2. In **Edge Functions › Secrets**, add `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` set to `mailto:` plus an email address you check, like `mailto:pastor@yourchurch.org`.
3. Put the public key in `www/config.js` as `vapidPublicKey`.

On iPhone, Apple only allows notifications for websites that have been added to the Home Screen (Share › Add to Home Screen, iOS 16.4 or newer). Selah's Settings explains this to iPhone users in Safari.

### 4. Android

1. Go to the [Firebase console](https://console.firebase.google.com), click **Create a project**, and name it Selah. You can turn off Google Analytics.
2. Click **Add app › Android**. For the package name, enter your app id from `capacitor.config.json` (`com.selahapp.selah` unless you changed it). Download `google-services.json` and put it in `android/app/`.
3. In Firebase, open **Project settings › Service accounts** and click **Generate new private key**. This downloads a JSON file. Keep it private: never put it in the app or share it.
4. In **Edge Functions › Secrets**, add `FCM_SERVICE_ACCOUNT` and paste the entire contents of that JSON file.
5. Run `npm run android` and build the app again.

### 5. iPhone

1. In your [Apple Developer account](https://developer.apple.com/account), open **Certificates, IDs & Profiles › Keys**, click **+**, name it "Selah push", tick **Apple Push Notifications service (APNs)**, and create it. Download the `.p8` file (Apple only lets you download it once) and note the **Key ID**. Your **Team ID** is under **Membership details**.
2. In **Edge Functions › Secrets**, add:
   - `APNS_KEY`: the full contents of the `.p8` file, including the `BEGIN` and `END` lines
   - `APNS_KEY_ID` and `APNS_TEAM_ID`
   - `APNS_BUNDLE_ID`: your app id, like `com.selahapp.selah`
   - `APNS_PRODUCTION`: `false` while you test with builds from Xcode, then `true` once you use TestFlight or the App Store. Apple uses separate systems for the two, and test phones and store phones can't share one setting.
3. The iPhone project already has push turned on (`ios/App/App/App.entitlements`). In Xcode, check that **Signing & Capabilities** lists **Push Notifications**. If it doesn't, click **+ Capability** and add it.
4. Test on a real iPhone.

### What people see

- After logging in, Selah asks once whether to turn on notifications. It waits a moment and never interrupts something they're doing. Each device has its own switch in **Profile › Settings › Push notifications**.
- The Likes, Comments and Messages switches in Settings apply to push too.
- Tapping a notification opens the conversation, the post or the Friends tab.
- While Selah is open, there's no system notification; the app shows its own banner instead.
- Logging out stops notifications on that device. Blocked people never trigger one.

### If notifications don't arrive

- **Table Editor › push_tokens** lists every registered device. If a device isn't there, permission wasn't given or registration failed. On Android, check that `google-services.json` is in `android/app/`.
- **Edge Functions › push › Logs** shows "push failures" with the reason Apple, Google or the browser gave.
- Devices the push services report as gone (app deleted, for example) are removed automatically.

### Testing push on your computer

`tests/push.test.mjs` checks the whole path with stand-ins for Apple, Google and a browser that check signatures and decrypt messages the way the real services do:

```bash
npx supabase start
node tests/push-mock/keys.js     # makes throwaway test keys
node tests/push-mock/server.js   # fake push services; leave running in its own terminal
npx supabase functions serve --env-file tests/push-mock/push.env --no-verify-jwt   # its own terminal too
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -c "insert into private.push_settings values (1, 'http://supabase_kong_selah-app:8000/functions/v1/push', 'test-push-secret') on conflict (id) do update set function_url = excluded.function_url, secret = excluded.secret"
npm run test:push
```

## Run it on your computer

Requires [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm start            # open http://localhost:8080
```

## Build the Android app

You need [Android Studio](https://developer.android.com/studio).

```bash
npm install
npm run android      # copies www/ into the Android project and opens Android Studio
```

In Android Studio, press Run to try it on a phone or emulator. For the Play Store, use **Build › Generate Signed App Bundle**.

## Build the iPhone app

You need a Mac with [Xcode](https://developer.apple.com/xcode/).

```bash
npm install
npm run ios          # copies www/ into the iOS project and opens Xcode
```

In Xcode, pick your team under **Signing & Capabilities**, then press Run. For the App Store, use **Product › Archive**.

## After changing the app

Edit files in `www/`, then run `npm run sync` to copy them into both native projects. If you change the web version, also bump `VERSION` in `www/sw.js` so installed copies pick up the update.

To change the app icon or splash screen, replace the images in `resources/` and run `npm run assets`.

## Before publishing to the stores

1. **Turn on accounts** with the steps above, including your own email provider.
2. **Turn on push notifications** with the steps above.
3. **Someone to review reports.** Apple and Google require that reports reach a person who acts on them. Decide who on your team checks the `reports` table, and how often. Because many users may be teens in youth groups, also think about parental involvement for younger members.
4. **A privacy policy and terms.** Both stores require a privacy policy link. Account deletion is already built in (Settings › Delete account), and the community guidelines are in the app.
5. **Developer accounts.** Apple Developer Program ($99/year) and Google Play Console ($25 one-time).
6. **More Bible translations.** The app includes the complete KJV, BSB and ASV, which are all public domain. Modern translations like NIV, ESV or NLT need a license from their publishers, for example through API.Bible.
7. **Your app id.** `com.selahapp.selah` is a placeholder. Pick your own (usually a domain you own, written backwards) before the first store upload, because it can't change after that. To change it: set `appId` in `capacitor.config.json`, delete `android/` and `ios/`, run `npx cap add android && npx cap add ios && npm run assets`, then add the camera and photo permissions back (below).

## Camera and photo permissions

These are already in the native projects. If you ever regenerate `android/` or `ios/`, add them again.

`android/app/src/main/AndroidManifest.xml`, next to the INTERNET permission:

```xml
<uses-permission android:name="android.permission.CAMERA" />
<uses-feature android:name="android.hardware.camera" android:required="false" />
```

`ios/App/App/Info.plist`, inside the top `<dict>`:

```xml
<key>NSCameraUsageDescription</key>
<string>Selah uses the camera so you can take photos for your Looking Glass and stories.</string>
<key>NSPhotoLibraryUsageDescription</key>
<string>Selah lets you choose photos from your library for posts, stories, Looking Glass and your profile picture.</string>
```
