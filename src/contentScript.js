/*
 *  Copyright 2018 - 2019 Mitsuha Kitsune <https://mitsuhakitsune.com>
 *  Licensed under the MIT license.
 */
/* eslint-disable */

import Logger from './logger';

class ContentScript {
  constructor(store, browser, settings) {
    this.store = store;
    this.browser = browser;
    this.settings = settings;
    this.scriptId = Math.random()
      .toString(36)
      .substr(2, 9);
    this.connection = null;
    this.receivedMutations = [];
    this.receivedActions = [];
    this.initialized = false;
    this.pendingMutations = [];
    this.pendingActions = [];

    // Connect to background script
    this.connection = browser.connectToBackground(`${this.settings.connectionName}_${this.scriptId}`);

    // Listen for messages
    this.connection.onMessage.addListener((message) => {
      this.onMessage(message);
    });

    // Hook mutations
    Logger.verbose(`Listening for mutations`);
    this.store.subscribe((mutation) => {
      this.hookMutation(mutation);
    });

    // Hook actions (Vuex version >= 2.5.0)
    if (this.settings.syncActions === true) {
      try {
        Logger.verbose(`Listening for actions`);
        this.store.subscribeAction((action) => {
          // Clean event object on payload, this produce error on webextensions messaging serialization ("The object could not be cloned.")
          if (action.payload instanceof Event) {
            action.payload = null;
          }

          this.hookAction(action);
        });
      } catch (err) {
        Logger.info(`Can't sync actions because isn't available in your Vuex version, use Vuex v2.5.0 or later for this feature`);
      }
    }
  }

  /**
   * Listener for incomming messages from background script.
   * @param {object} message - Message received from background script.
   * @returns {null} This function didn't return any value
   */
  onMessage(message) {
    Logger.verbose(`Received message from background`);

    // Don't process messages without type property, aren't from the plugin
    if (!message.type) {
      return;
    }

    switch (message.type) {
      // Process initial state from the background
      case '@@STORE_SYNC_STATE': {
        Logger.info(`Received store initial state`);
        this.store.commit('vweReplaceState', message.data);
        this.initialized = true;
        this.processPendingMutations();
        break;
      }

      // Process mutation messages from background script
      case '@@STORE_SYNC_MUTATION': {
        Logger.debug(`Received mutation ${message.data.type}`);

        // Don't commit any mutation from other contexts before the initial state sync
        if (!this.initialized) {
          Logger.info(`Received mutation (${message.data.type}) but the store isn't initilized yet`);
          break;
        }

        this.receivedMutations.push(message.data);
        this.store.commit(message.data.type, message.data.payload);
        break;
      }

      // Process action messages from background script
      case '@@STORE_SYNC_ACTION': {
        Logger.debug(`Received action ${message.data.type}`);

        // Don't commit any action from other contexts before the initial state sync
        if (!this.initialized) {
          Logger.info(`Received action (${message.data.type}) but the store isn't initilized yet`);
          break;
        }

        this.receivedActions.push(message.data);
        this.store.dispatch(message.data);
        break;
      }

      default: {
        break;
      }
    }
  }

  /**
   * Hook for retrieve the comited mutations from content script.
   * @param {object} mutation - Mutation comited on content script store.
   * @returns {null} This function didn't return any value
   */
  hookMutation(mutation) {
    Logger.debug(`Hooked mutation (${mutation.type})`);

    // If it's store initialization mutation don't send again to other contexts
    if (mutation.type === 'vweReplaceState') {
      Logger.debug(`vweReplaceState mutation don't need send to other contexts`);

      return;
    }

    // If it's ignored mutation don't sync with the other contexts
    if (this.settings.ignoredMutations.length > 0 && this.settings.ignoredMutations.includes(mutation.type)) {
      Logger.info(`Mutation (${mutation.type}) are on ignored mutations list, skiping...`);

      return;
    }

    // If store isn't initialized yet, just enque the mutation to reaply it after sync
    if (!this.initialized) {
      Logger.info(`Hooked mutation (${mutation.type}) before initialization, enqued on pending mutations`);

      return this.pendingMutations.push(mutation);
    }

    // If received mutations list are empty it's own mutation, send to background
    if (this.receivedMutations.length === 0) {
      this.sendMutation(mutation);
      return;
    }

    // Check if it's received mutation, if it's just ignore it, if not send to background
    const index = this.receivedMutations.findIndex((m) => m.type === mutation.type && JSON.stringify(m.payload) === JSON.stringify(mutation.payload));
    if (index !== -1) {
      Logger.verbose(`Mutation ${this.receivedMutations[index].type} it's received mutation, don't send to background again`);
      this.receivedMutations.splice(index, 1);
    } else {
      this.sendMutation(mutation);
    }
  }

  /**
   * Hook for retrieve the comited actions from content script.
   * @param {object} action - Action comited on content script store.
   * @returns {null} This function didn't return any value
   */
  hookAction(action) {
    Logger.debug(`Hooked action (${action.type})`);

    // If it's ignored action don't sync with the other contexts
    if (this.settings.ignoredActions.length > 0 && this.settings.ignoredActions.includes(action.type)) {
      Logger.info(`Action (${action.type}) are on ignored action list, skiping...`);

      return;
    }

    // If store isn't initialized yet, just enque the action to reaply it after sync
    if (!this.initialized) {
      Logger.info(`Hooked action (${action.type}) before initialization, enqued on pending actions`);

      return this.pendingActions.push(action);
    }

    // If received actions list are empty it's own action, send to background
    if (this.receivedActions.length === 0) {
      this.sendAction(action);
      return;
    }

    // Check if it's received action, if it's just ignore it, if not send to background
    const index = this.receivedActions.findIndex((a) => a.type === action.type && JSON.stringify(a.payload) === JSON.stringify(action.payload));
    if (index !== -1) {
      Logger.verbose(`Action ${this.receivedActions[index].type} it's received action, don't send to background again`);
      this.receivedActions.splice(index, 1);
    } else {
      this.sendAction(action);
    }
  }

  /**
   * Helper function to send mutations to background script.
   * @param {object} mutation - The mutation to send.
   * @returns {null} This function didn't return any value
   */
  sendMutation(mutation) {
    Logger.debug(`Sending mutation (${mutation.type}) to background script`);

    this.connection.postMessage({
      type: '@@STORE_SYNC_MUTATION',
      data: mutation
    });
  }

  /**
   * Helper function to send actions to background script.
   * @param {object} action - The action to send.
   * @returns {null} This function didn't return any value
   */
  sendAction(action) {
    Logger.debug(`Sending action (${action.type}) to background script`);

    this.connection.postMessage({
      type: '@@STORE_SYNC_ACTION',
      data: action
    });
  }

  /**
   * Process pending mutations queue.
   * @returns {null} This function didn't return any value
   */
  processPendingMutations() {
    Logger.debug(`Processing pending mutations list...`);

    if (!this.pendingMutations.length) {
      Logger.info(`The pending mutations list are empty`);
      return;
    }

    while (this.pendingMutations.length > 0) {
      const mutation = this.pendingMutations.shift();
      Logger.verbose(`Processing pending mutation (${mutation.type}) with payload: ${mutation.payload}`);
      this.store.commit(mutation.type, mutation.payload);
    }
  }

  /**
   * Process pending actions queue.
   * @returns {null} This function didn't return any value
   */
  processPendingActions() {
    Logger.debug(`Processing pending actions list...`);

    if (!this.pendingActions.length) {
      Logger.info(`The pending actions list are empty`);
      return;
    }

    while (this.pendingActions.length > 0) {
      const action = this.pendingActions.shift();
      Logger.verbose(`Processing pending action (${action.type}) with payload: ${action.payload}`);
      this.store.dispatch(action.type, action.payload);
    }
  }
}

export default ContentScript;
