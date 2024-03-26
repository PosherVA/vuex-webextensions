/*
 *  Copyright 2018 - 2019 Mitsuha Kitsune <https://mitsuhakitsune.com>
 *  Licensed under the MIT license.
 */
/* eslint-disable */

import Logger from './logger';
import { filterObject } from './utils';

class BackgroundScript {
  constructor(store, browser, settings) {
    this.store = store;
    this.browser = browser;
    this.settings = settings;
    this.connections = [];

    // Restore persistent state datas from localstorage
    if (this.settings.persistentStates.length) {
      Logger.info(`Persistent states detected on config, reading from storage...`);

      this.browser.getPersistentStates().then((savedStates) => {
        if (savedStates !== null) {
          Logger.verbose(`Saved persistent states found on localstorage`);

          this.store.commit('vweReplaceState', {
            ...this.store.state,
            ...filterObject(savedStates, this.settings.persistentStates)
          });

          // Sync loaded state with all connections
          if (this.connections.length > 0) {
            Logger.info(`Sending initial state to other contexts...`);

            for (let i = this.connections.length - 1; i >= 0; i--) {
              this.syncCurrentState(this.connections[i]);
            }
          }
        } else {
          Logger.debug(`No data found on localstorage for persistent states`);
        }
      });
    }

    // Hook mutations
    this.store.subscribe((mutation) => {
      Logger.debug(`Hooked mutation (${mutation.type})`);

      // If it's ignored mutation don't sync with the other contexts
      if (this.settings.ignoredMutations.length > 0 && this.settings.ignoredMutations.includes(mutation.type)) {
        Logger.info(`Mutation (${mutation.type}) are on ignored mutations list, skiping...`);

        return;
      }

      // refactored code version
      // Send mutation to all connections
      this.connections.forEach((connection) => {
        // Skip connections not related to vuex-webextensions and without a valid name
        if (typeof connection.name !== 'string' || !connection.name.includes('vuex-webextensions')) {
          // Logger.debug(`Connection is missing a valid name or is not a vuex-webextensions connection, skip`);
          return;
        }

        let shouldSend = true;

        // Check if the mutation was received from this connection
        for (let j = connection.receivedMutations.length - 1; j >= 0; j--) {
          if (connection.receivedMutations[j].type === mutation.type && JSON.stringify(connection.receivedMutations[j].payload) === JSON.stringify(mutation.payload)) {
            // If it matches, remove it from the list and don't send it back
            connection.receivedMutations.splice(j, 1);
            shouldSend = false;
            break;
          }
        }

        // If the mutation should be sent, send it
        if (shouldSend) {
          this.sendMutation(connection, mutation);
        }
      });

      // Save persistent states to local storage
      this.browser.savePersistentStates(filterObject(this.store.state, this.settings.persistentStates));
    });

    // Hook actions (Vuex version => 2.5.0)
    if (this.settings.syncActions === true) {
      try {
        Logger.verbose(`Listening for actions`);

        this.store.subscribeAction((action) => {
          Logger.debug(`Hooked action (${action.type})`);

          // If it's ignored action don't sync with the other contexts
          if (this.settings.ignoredActions.length > 0 && this.settings.ignoredActions.includes(action.type)) {
            Logger.info(`Action (${action.type}) are on ignored actions list, skiping...`);

            return;
          }

          // refactored code version
          // Send action to connections pool
          this.connections.forEach((connection) => {
            // Skip connections not related to vuex-webextensions and without a valid name
            if (typeof connection.name !== 'string' || !connection.name.includes('vuex-webextensions')) {
              // Logger.debug(`Connection ${connection.name} is not a vuex-webextensions connection, skip`);
              return;
            }

            let shouldSend = true;

            // Check if the action was received from this connection
            for (let j = connection.receivedActions.length - 1; j >= 0; j--) {
              if (connection.receivedActions[j].type === action.type) {
                // If it matches, remove it from the list and don't send it back
                connection.receivedActions.splice(j, 1);
                shouldSend = false;
                break;
              }
            }

            // If the action should be sent, send it
            if (shouldSend) {
              this.sendAction(connection, action);
            }
          });
        });
      } catch (err) {
        Logger.info(`Can't sync actions because isn't available in your Vuex version, use Vuex v2.5.0 or later for this feature`);
      }
    }

    // Start listening for connections
    this.browser.handleConnection((connection) => {
      this.onConnection(connection);
    });
  }

  onConnection(connection) {
    // Remove from connections on disconnect
    connection.onDisconnect.addListener((conn) => {
      this.onDisconnect(conn);
    });

    // Initialize empty lists of receivedMutations and receivedActions
    connection.receivedMutations = [];
    connection.receivedActions = [];

    // Listen to messages
    connection.onMessage.addListener((message) => {
      this.onMessage(connection, message);
    });

    // Add to connections pool
    this.connections.push(connection);

    // Send current state
    this.syncCurrentState(connection);
  }

  onDisconnect(connection) {
    for (let i = this.connections.length - 1; i >= 0; i--) {
      if (this.connections[i].name === connection.name) {
        this.connections.splice(i, 1);
      }
    }
  }

  onMessage(connection, message) {
    if (!message.type) {
      return;
    }

    switch (message.type) {
      // Process mutation messages from content scripts
      case '@@STORE_SYNC_MUTATION': {
        connection.receivedMutations.push(message.data);
        this.store.commit(message.data.type, message.data.payload);
        break;
      }

      // Process action messages from content scripts
      case '@@STORE_SYNC_ACTION': {
        connection.receivedActions.push(message.data);
        this.store.dispatch(message.data.type, message.data.payload);
        break;
      }

      default: {
        break;
      }
    }
  }

  syncCurrentState(connection) {
    try {
      connection.postMessage({
        type: '@@STORE_SYNC_STATE',
        data: this.store.state
      });
    } catch (err) {
      Logger.error(`Initial state not sent: ${err}`);
    }
  }

  sendMutation(connection, mutation) {
    Logger.verbose(`Sending mutation (${mutation.type}) to connection: ${connection.name}`);

    try {
      connection.postMessage({
        type: '@@STORE_SYNC_MUTATION',
        data: mutation
      });
    } catch (err) {
      Logger.error(`Mutation not sent: ${err}`);
    }
  }

  sendAction(connection, action) {
    Logger.verbose(`Sending action (${action.type}) to connection: ${connection.name}`);

    try {
      connection.postMessage({
        type: '@@STORE_SYNC_ACTION',
        data: action
      });
    } catch (err) {
      Logger.error(`Action not sent: ${err}`);
    }
  }
}

export default BackgroundScript;
