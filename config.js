// ============================================================================
// EDIT THIS FILE with your own keys — nothing else in this project needs to
// change when you rotate a key or move to a new Firebase/EmailJS project.
// ============================================================================

window.TOPSPIN_CONFIG = {
  // ---- Firebase project settings ----
  // Firebase console → Project settings → General → "Your apps" → SDK setup
  // and configuration → Config. Paste the whole object Firebase gives you.
  firebase: {
    apiKey: "PASTE_YOUR_FIREBASE_API_KEY",
    authDomain: "PASTE_YOUR_PROJECT.firebaseapp.com",
    projectId: "PASTE_YOUR_PROJECT_ID",
    storageBucket: "PASTE_YOUR_PROJECT.appspot.com",
    messagingSenderId: "PASTE_YOUR_SENDER_ID",
    appId: "PASTE_YOUR_APP_ID",
  },

  // ---- EmailJS settings ----
  // EmailJS dashboard → Account → General for publicKey.
  // EmailJS dashboard → Email Services for serviceId.
  // EmailJS dashboard → Email Templates for the three template IDs below —
  // create three templates (see SETUP_GUIDE.md for suggested starter text):
  //   1. reminderTemplateId  — RSVP reminder, sent to everyone, 3 days before deadline
  //   2. scheduleTemplateId  — "here's your match" email, sent to players who are IN
  //   3. sitoutTemplateId    — "you're sitting this week" email, sent to whoever sat out
  // Leave any of these blank ("") to turn that email off without touching code.
  emailjs: {
    publicKey: "",
    serviceId: "",
    reminderTemplateId: "",
    scheduleTemplateId: "",
    sitoutTemplateId: "",
  },

  // Shown in the browser tab and a couple of places in the UI.
  siteName: "The Topspin Open",
};
