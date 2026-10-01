/* Text-only DOM construction for menu copy and keyboard hints. */
(function () {
  'use strict';
  function paragraphs(container, ...lines) {
    container.replaceChildren(...lines.map(text => {
      const paragraph = document.createElement('p');
      paragraph.textContent = text;
      return paragraph;
    }));
  }
  function buttonLabel(button, label, shortcut) {
    const key = document.createElement('kbd');
    key.textContent = shortcut;
    button.replaceChildren(document.createTextNode(label + ' '), key);
  }
  window.CoinQuestUI = Object.freeze({ paragraphs, buttonLabel });
})();
