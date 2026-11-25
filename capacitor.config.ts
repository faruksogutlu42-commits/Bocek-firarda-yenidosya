import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.bocekfirar.runner',
  appName: 'Bug Escape',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  plugins: {
    // index.html'de viewport-fit=cover var. Bu ipucu verilmezse SystemBars sayfa
    // yüklenene kadar WebView'a sistem çubuğu kadar padding veriyor; açılış
    // görseli ilk anlarda ekranı tam kaplamıyordu.
    SystemBars: {
      initialViewportFitValueHint: 'cover',
    },
    LocalNotifications: {
      smallIcon: 'ic_stat_bocek',
      iconColor: '#10b981',
    },
  },
};

export default config;
