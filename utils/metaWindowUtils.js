'use strict';

/**
 * Get the stable window id, don't change even after gnome shell is restarted
 * 
 * On X11, return xid; On Wayland, return id
 * 
 * @returns stable window id
 */
export const getStableWindowId = function(metaWindow) {
    return metaWindow.get_id();
}

export const isSurfaceActor = function(clutterActor) {
    const className = clutterActor.constructor.$gtype.name;
    // Excepted MetaSurfaceActorX11 and MetaSurfaceActorWayland on X11 and Wayland, respectively
    return className.startsWith('MetaSurfaceActor');
}
