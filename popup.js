document.addEventListener('DOMContentLoaded', () => {
  const dashboardBtn = document.getElementById('dashboardBtn');

  dashboardBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: 'dashboard.html' });
  });
});