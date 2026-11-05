'use strict';

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import * as SaveSession from '../saveSession.js';
import * as CloseSession from '../closeSession.js';
import * as RestoreSession from '../restoreSession.js';
import * as InfoDialog from './infoDialog.js';

import * as FileUtils from '../utils/fileUtils.js';
import * as Log from '../utils/log.js';

import {Button} from './button.js';


export const PopupMenuButtonItems = GObject.registerClass(
class PopupMenuButtonItems extends GObject.Object {

    _init() {
        super._init();
        this.buttonItems = [];
        this.addButtonItems();
    }

    addButtonItems() {
        const popupMenuButtonItemClose = new PopupMenuButtonItemClose('close-symbolic.svg');
        const popupMenuButtonItemSave = new PopupMenuButtonItemSave('save-symbolic.svg');
        const popupMenuButtonItemInfo = new PopupMenuButtonItemInfo('info-symbolic.svg');
        
        this.buttonItems.push(popupMenuButtonItemClose);
        this.buttonItems.push(popupMenuButtonItemSave);
        this.buttonItems.push(popupMenuButtonItemInfo);
    }

});


const PopupMenuButtonItem = GObject.registerClass(
class PopupMenuButtonItem extends PopupMenu.PopupMenuItem {

    _init() {
        super._init('');
        this.add_style_class_name('awsm-action-row');

        this.yesButton = null;
        this.noButton = null;
    }

    /**
     * Hide both Yes and No buttons by default
     */
    createYesAndNoButtons() {
        this.yesButton = this.createButton('emblem-ok-symbolic');
        this.noButton = this.createButton('edit-undo-symbolic');
        this.yesButton.add_style_class_name('confirm-before-operate');
        this.noButton.add_style_class_name('confirm-before-operate');
        this.hideYesAndNoButtons();
    }

    showYesAndNoButtons() {
        this.yesButton.show();
        this.noButton.show();
    }

    hideYesAndNoButtons() {
        this.yesButton.hide();
        this.noButton.hide();
    }

    createButton(iconSymbolic) {
        const button = new Button({
            icon_symbolic: iconSymbolic,
            button_style_class: 'button-item',
        }).button;
        return button;
    }

    createTimeLine() {
        // Set actor when using
        const timeline = new Clutter.Timeline({
            // 2s
            duration: 2000,
            repeat_count: 0,
        });
        return timeline;
    }

    // Add the icon description
    addIconDescription(iconDescription) {
        this.iconDescriptionLabel = new St.Label({
            text: iconDescription
        });
        this.actor.add_child(this.iconDescriptionLabel);
    }

});


const PopupMenuButtonItemInfo = GObject.registerClass(
class PopupMenuButtonItemInfo extends PopupMenuButtonItem {

    _init(iconSymbolic) {
        super._init();
        this._infoDialog = null;
        this._openInfoDialogId = 0;

        this._createButton(iconSymbolic);
        this.addIconDescription('Project information');
        this._createExternalActionButtons();
        this.connect('activate', this._onActivate.bind(this));
    }

    _createButton(iconSymbolic) {
        const infoButton = super.createButton(iconSymbolic);
        this.actor.add_child(infoButton);
        infoButton.connect('clicked', this._onClicked.bind(this));
    }

    _createExternalActionButtons() {
        // Keep both external actions on the same Project information row.
        // Add them directly to PopupMenuItem, like the working session-row actions.
        const preferencesButton = super.createButton('preferences-system-symbolic.svg');
        preferencesButton.set_size(28, 28);
        preferencesButton.accessible_name = 'Extension settings';
        this.actor.add_child(preferencesButton);
        preferencesButton.connect('clicked', () => {
            this._openExternalCommand([
                'gnome-extensions',
                'prefs',
                'another-window-session-manager@gmail.com',
            ], 'Failed to open extension preferences');
        });

        const extensionsButton = super.createButton('applications-system-symbolic.svg');
        extensionsButton.set_size(28, 28);
        extensionsButton.accessible_name = 'GNOME Extensions';
        this.actor.add_child(extensionsButton);
        extensionsButton.connect('clicked', () => {
            this._openExternalCommand(
                ['gnome-extensions-app'],
                'Failed to open GNOME Extensions');
        });
    }

    _openExternalCommand(command, errorMessage) {
        if (this._parent) {
            this._parent.close();
        }

        try {
            Gio.Subprocess.new(command, Gio.SubprocessFlags.NONE);
        } catch (e) {
            Log.Log.getDefault().error(e, errorMessage);
        }
    }

    _onActivate() {
        this._onClicked();
    }

    _onClicked() {
        if (this._parent) {
            this._parent.close();
        }

        this._infoDialog = new InfoDialog.AwsInfoDialog();
        this._openInfoDialogId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._openInfoDialogId = 0;
            if (this._infoDialog) {
                this._infoDialog.open();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        if (this._openInfoDialogId) {
            GLib.Source.remove(this._openInfoDialogId);
            this._openInfoDialogId = 0;
        }
        if (this._infoDialog) {
            this._infoDialog.close();
            this._infoDialog = null;
        }
        super.destroy();
    }
});


const PopupMenuButtonItemClose = GObject.registerClass(
class PopupMenuButtonItemClose extends PopupMenuButtonItem {

    _init(iconSymbolic) {
        super._init();
        this.confirmLabel;
        
        this.closingLabel;

        this.closeSession = new CloseSession.CloseSession(CloseSession.flags.closeWindows);

        this._createButton(iconSymbolic);
        this.addIconDescription('Close open windows');
        this._addConfirm();
        this._addYesAndNoButtons();
        this._addClosingPrompt();

        this._hideConfirm();

        this._timeline = this.createTimeLine();

        // Respond to menu item's 'activate' signal so user don't need to click the icon whose size is too small to find to click
        this.connect('activate', this._onActivate.bind(this));

    }

    _onActivate() {
        this._onClicked();
    }

    _hideConfirm() {
        this.confirmLabel.hide();
        this.hideYesAndNoButtons();
        this.closingLabel.hide();
    }

    _addYesAndNoButtons() {
        super.createYesAndNoButtons();
        
        this.yesButton.connect('clicked', () => {
            // TODO Do this when enable_close_by_rules is true? 
            this._parent.close();
            if (Main.overview.visible) {
                Main.overview.toggle();
            }

            RestoreSession.restoreSessionObject.restoringApps.clear();
            this.closeSession.closeWindows();
            this._hideConfirm();

            // Set the actor the timeline is associated with to make sure Clutter.Timeline works normally.
            // Set the actor in new Clutter.Timeline don't work
            this._timeline.set_actor(this.closingLabel);
            this._timeline.connect('new-frame', (_timeline, _frame) => {
                this.closingLabel.show();
            });
            this._timeline.start();
            this._timeline.connect('completed', () => {
                this._timeline.stop();
                this.closingLabel.hide();
            });

        });

        this.noButton.connect('clicked', () => {
            this._hideConfirm();
        });

        this.actor.add_child(this.yesButton);
        this.actor.add_child(this.noButton);

    }

    _addClosingPrompt() {
        this.closingLabel = new St.Label({
            style_class: 'confirm-before-operate',
            text: 'Closing open windows ...',
            x_expand: false,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.add_child(this.closingLabel);
    }

    _createButton(iconSymbolic) {
        const closeButton = super.createButton(iconSymbolic);
        this.actor.add_child(closeButton);
        closeButton.connect('clicked', this._onClicked.bind(this));
    }

    _onClicked(button, event) {
        // In case someone hide close button again when this.closingLabel is still showing
        this._timeline.stop();
        this.closingLabel.hide();

        this.confirmLabel.show();
        this.showYesAndNoButtons();
    }

    _addConfirm() {
        this.confirmLabel = new St.Label({
            style_class: 'confirm-before-operate',
            text: 'Confirm?',
            x_expand: false,
            x_align: Clutter.ActorAlign.START,
        });
        this.actor.add_child(this.confirmLabel);
    }

    destroy() {
        // TODO Nullify others created objects?

        // TODO Also disconnect new-frame and completed?
        if (this._timeline) {
            this._timeline.stop();
            this._timeline = null;
        }

    }

});


const PopupMenuButtonItemSave = GObject.registerClass(
class PopupMenuButtonItemSave extends PopupMenuButtonItem {

    _init(iconSymbolic) {
        super._init();
        this.saveCurrentSessionEntry = null;
        this._createButton(iconSymbolic);
        this.addIconDescription('Save open windows');
        this._addEntry();
        // Hide this St.Entry, only shown when user click saveButton.
        this.saveCurrentSessionEntry.hide();
        this._addYesAndNoButtons();

        this._log = new Log.Log();

        this._saveSession = new SaveSession.SaveSession(true);

        this._timeline = this.createTimeLine();

        this.savingLabel = null;
        
        this._addSavingPrompt();

        // Respond to menu item's 'activate' signal so user don't need to click the icon whose size is too small to find to click
        this.connect('activate', this._onActivate.bind(this));

    }

    _addYesAndNoButtons() {
        super.createYesAndNoButtons();
        
        this.yesButton.connect('clicked', this._onClickedYes.bind(this));
        this.noButton.connect('clicked', () => {
            // clear entry
            this.saveCurrentSessionEntry.set_text('');
            this.saveCurrentSessionEntry.hide();
            super.hideYesAndNoButtons();
        });

        this.actor.add_child(this.yesButton);
        this.actor.add_child(this.noButton);

    }

    _onClickedYes(button, event) {
        this._gotoSaveSession();
    }

    _onActivate() {
        this._onClickedBeginSave();
    }

    _addSavingPrompt() {
        this.savingLabel = new St.Label({
            style_class: 'confirm-before-operate',
            x_expand: false,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.add_child(this.savingLabel);
    }

    _createButton(iconSymbolic) {
        const saveButton = super.createButton(iconSymbolic);
        this.actor.add_child(saveButton);
        saveButton.connect('clicked', this._onClickedBeginSave.bind(this));
    }

    _onClickedBeginSave(button, event) {
        this._timeline.stop();
        this.savingLabel.hide();

        this.saveCurrentSessionEntry.show();
        this.saveCurrentSessionEntry.grab_key_focus();
        super.showYesAndNoButtons();
    }

    _addEntry() {
        this.saveCurrentSessionEntry = new St.Entry({
            name: 'saveCurrentSession',
            hint_text: "Type a session name, default is defaultSession",
            track_hover: true,
            can_focus: true
        });
        const clutterText = this.saveCurrentSessionEntry.clutter_text;
        clutterText.connect('activate', this._onTextActivate.bind(this));
        this.actor.add_child(this.saveCurrentSessionEntry);

    }

    _onTextActivate(entry, event) {
        this._gotoSaveSession();
    }

    _gotoSaveSession() {
        let sessionName = this.saveCurrentSessionEntry.get_text();
        if (sessionName) {
            // '  ' is truthy
            if (!sessionName.trim()) {
                sessionName = FileUtils.default_sessionName;
            }
        } else {
            sessionName = FileUtils.default_sessionName;
        }

        const [canSave, reason] = this._canSave(sessionName);
        if (!canSave) {
            this._displayMessage(reason);
            return;
        }

        // clear entry
        this.saveCurrentSessionEntry.set_text('');
        
        this.saveCurrentSessionEntry.hide();
        super.hideYesAndNoButtons();

        this.savingLabel.set_text(`Saving open windows as '${sessionName}' ...`);
        this.savingLabel.show();

        this._saveSession.saveSessionAsync(sessionName).then(() => {
            this.savingLabel.hide();
        }).catch(e => {
            let message = `Failed to save session`;
            this._log.error(e, e.desc ?? message);
            global.notify_error(message, e.cause?.message ?? e.desc ?? message);
            this._displayMessage(e.cause?.message ?? e.message);
        });

    }

    _displayMessage(message) {
        // To prevent saving session many times by holding and not releasing Enter
        this.saveCurrentSessionEntry.hide();
        this.savingLabel.set_text(message);
        this._timeline.set_actor(this.savingLabel);
        const newFrameId = this._timeline.connect('new-frame', (_timeline, _frame) => {
            this._timeline.disconnect(newFrameId);
            this.savingLabel.show();
            this.hideYesAndNoButtons();
        });
        this._timeline.start();
        const completedId = this._timeline.connect('completed', () => {
            this._timeline.disconnect(completedId);
            this._timeline.stop();
            this.savingLabel.hide();
            this.saveCurrentSessionEntry.show();
            this.showYesAndNoButtons();
        });
    }

    _canSave(sessionName) {
        if (sessionName === FileUtils.sessions_backup_folder_name) {
            return [false, `ERROR: ${sessionName} is a reserved word, can't be used.`];
        }

        if (FileUtils.isDirectory(sessionName)) {
            return [false, `ERROR: Can't save windows using '${sessionName}', it's an existing directory!`];
        }

        if (sessionName.indexOf('/') != -1) {
            return [false, `ERROR: Session names cannot contain '/'`];
        }
        return [true, ''];
    }

    destroy() {
        // TODO Nullify others created objects?

        // TODO Also disconnect new-frame and completed?
        if (this._timeline) {
            this._timeline.stop();
            this._timeline = null;
        }

    }
    

});
