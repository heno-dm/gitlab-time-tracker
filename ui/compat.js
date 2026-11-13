// Small shims for API differences between the supported GNOME Shell versions.
import Clutter from 'gi://Clutter';
import St from 'gi://St';

// GNOME 48 added `orientation` to St widgets and deprecated `vertical`;
// GNOME 51 removed `vertical`. Spread this into St.BoxLayout constructor
// properties to get a vertical box on every supported version.
export const VERTICAL = St.BoxLayout.find_property('orientation')
    ? {orientation: Clutter.Orientation.VERTICAL}
    : {vertical: true};
