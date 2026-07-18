document.addEventListener('DOMContentLoaded', async () => {
  const downloadVideoBtn = document.getElementById('downloadVideoBtn');
  const downloadImageBtn = document.getElementById('downloadImageBtn');
  const statusDiv = document.getElementById('popupStatus');
  const statusText = document.getElementById('popupStatusText');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const currentUrl = tab.url;

  const supported = ['tiktok', 'instagram', 'twitter', 'x.com', 'pinterest', 'pin.it', 'snapchat', 'facebook', 'fb.watch'];
  const isSupported = supported.some(s => currentUrl.includes(s));

  if (!isSupported) {
    statusDiv.classList.remove('hidden');
    statusText.textContent = '⚠️ This page is not supported yet.';
    downloadVideoBtn.disabled = true;
    downloadImageBtn.disabled = true;
    return;
  }

  downloadVideoBtn.addEventListener('click', async () => {
    statusDiv.classList.remove('hidden');
    statusText.textContent = '🎬 Resolving video...';
    downloadVideoBtn.disabled = true;

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'resolve',
        url: currentUrl
      });

      if (!response.success) {
        statusText.textContent = '❌ ' + response.error;
        downloadVideoBtn.disabled = false;
        return;
      }

      const data = response.data;

      if (data.hasVideo) {
        statusText.textContent = '⬇️ Downloading video...';
        await chrome.runtime.sendMessage({
          action: 'download',
          url: currentUrl,
          mode: 'video'
        });
        statusText.textContent = '✅ Download started! Check your downloads.';
        setTimeout(() => window.close(), 1500);
      } else {
        statusText.textContent = '⚠️ No video found on this page.';
        downloadVideoBtn.disabled = false;
      }
    } catch (err) {
      statusText.textContent = '❌ ' + err.message;
      downloadVideoBtn.disabled = false;
    }
  });

  downloadImageBtn.addEventListener('click', async () => {
    statusDiv.classList.remove('hidden');
    statusText.textContent = '🖼️ Resolving image...';
    downloadImageBtn.disabled = true;

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'resolve',
        url: currentUrl
      });

      if (!response.success) {
        statusText.textContent = '❌ ' + response.error;
        downloadImageBtn.disabled = false;
        return;
      }

      const data = response.data;

      if (data.hasImage) {
        statusText.textContent = '⬇️ Downloading image...';
        await chrome.runtime.sendMessage({
          action: 'download',
          url: currentUrl,
          mode: 'image'
        });
        statusText.textContent = '✅ Download started! Check your downloads.';
        setTimeout(() => window.close(), 1500);
      } else {
        statusText.textContent = '⚠️ No image found on this page.';
        downloadImageBtn.disabled = false;
      }
    } catch (err) {
      statusText.textContent = '❌ ' + err.message;
      downloadImageBtn.disabled = false;
    }
  });

  document.getElementById('popupSettings').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
});
