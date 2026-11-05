'use strict';

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as IconFinder from '../utils/iconFinder.js';

const NAME = 'Another Window Session Manager';
const SHORT_NAME = 'AWSM';
const GITHUB = 'https://github.com/AhmetsWorkSpace/awsm-gnome-session-manager';
const DETAILS = [
    ['Proje', NAME], ['Kısaltma', SHORT_NAME],
    ['Geliştirici / son düzenleyen', 'Sezen'],
    ['Son düzenleme', '4 Kasım 2026'], ['Sürüm', '51'],
    ['Lisans', 'GNU GPL v3'],
];

export const AwsInfoDialog = GObject.registerClass(
class AwsInfoDialog extends ModalDialog.ModalDialog {
    _init() {
        super._init({styleClass: 'awsm-info-dialog', destroyOnClose: true});
        this.contentLayout.add_child(this._createContent());
        this.addButton({action: () => this.close(), label: 'Kapat', key: Clutter.KEY_Escape});
    }

    _createContent() {
        const content = new St.BoxLayout({vertical: true, style_class: 'awsm-info-content', x_expand: true});
        const header = new St.BoxLayout({style_class: 'awsm-info-header', x_expand: true});
        header.add_child(new St.Icon({gicon: IconFinder.find('info-symbolic.svg'), style_class: 'awsm-info-icon'}));
        const title = new St.BoxLayout({vertical: true, style_class: 'awsm-info-title-box', x_expand: true});
        title.add_child(new St.Label({text: NAME, style_class: 'awsm-info-title'}));
        title.add_child(new St.Label({text: `${SHORT_NAME} • GNOME 50 • Wayland`, style_class: 'awsm-info-subtitle'}));
        header.add_child(title);
        content.add_child(header);
        content.add_child(new St.Label({
            text: 'GNOME Wayland için çoklu monitör destekli oturum ve pencere yöneticisi.',
            style_class: 'awsm-info-description', x_expand: true,
        }));

        const details = new St.BoxLayout({vertical: true, style_class: 'awsm-info-details', x_expand: true});
        for (const [label, value] of DETAILS) details.add_child(this._createRow(label, value));
        details.add_child(this._createRow('GitHub', GITHUB, true));
        content.add_child(details);
        content.add_child(new St.Label({
            text: 'AWSM; oturumları, çalışma alanlarını, monitör konumlarını ve pencere durumlarını GNOME Shell üzerinden yönetmek için tasarlanmıştır.',
            style_class: 'awsm-info-footer', x_expand: true,
        }));
        return content;
    }

    _createRow(label, value, isLink = false) {
        const row = new St.BoxLayout({style_class: 'awsm-info-row', x_expand: true});
        row.add_child(new St.Label({text: label, style_class: 'awsm-info-label'}));
        if (!isLink) {
            row.add_child(new St.Label({
                text: value, style_class: 'awsm-info-value',
                x_expand: true, x_align: Clutter.ActorAlign.END,
            }));
            return row;
        }

        const link = new St.Button({
            label: value, style_class: 'awsm-info-link', can_focus: true,
            x_expand: true, x_align: Clutter.ActorAlign.END,
        });
        link.connect('clicked', () => {
            try {
                Gio.AppInfo.launch_default_for_uri(value, null);
            } catch (e) {
                logError(e, `Failed to open project URL: ${value}`);
            }
        });
        row.add_child(link);
        return row;
    }
});
