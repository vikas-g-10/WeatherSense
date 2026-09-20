use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter,
    Manager,
    WindowEvent,
};

use tokio::sync::watch;
use tokio::time::Duration;

#[derive(Clone, Debug)]
struct SchedulerConfig {
    interval_minutes: u64,
    monitoring_enabled: bool,
}

#[tauri::command]
fn update_scheduler(
    tx: tauri::State<'_, watch::Sender<SchedulerConfig>>,
    interval_minutes: u64,
    monitoring_enabled: bool,
) -> Result<(), String> {
    // Only allow the intervals available in WeatherSense Settings.
    if ![5, 10, 15, 30, 60].contains(&interval_minutes) {
        return Err("Invalid monitoring interval".to_string());
    }

    let config = SchedulerConfig {
        interval_minutes,
        monitoring_enabled,
    };

    tx.send(config).map_err(|_| {
        "WeatherSense scheduler is no longer running".to_string()
    })?;

    println!(
        "WeatherSense scheduler updated: {} minutes, enabled: {}",
        interval_minutes,
        monitoring_enabled
    );

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    /*
     * Shared scheduler configuration.
     *
     * The watch channel allows the React Settings screen
     * to immediately notify the background scheduler when
     * the monitoring interval or enabled state changes.
     */
    let (scheduler_tx, scheduler_rx) =
        watch::channel(SchedulerConfig {
            interval_minutes: 15,
            monitoring_enabled: true,
        });

    tauri::Builder::default()
        .manage(scheduler_tx.clone())
        .plugin(tauri_plugin_notification::init())
        .setup(move |app| {
            /*
             * Development logging
             */
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            /*
             * ============================
             * SYSTEM TRAY MENU
             * ============================
             */

            let open_item = MenuItem::with_id(
                app,
                "open",
                "Open WeatherSense",
                true,
                None::<&str>,
            )?;

            let check_item = MenuItem::with_id(
                app,
                "check",
                "Check Now",
                true,
                None::<&str>,
            )?;

            let settings_item = MenuItem::with_id(
                app,
                "settings",
                "Settings",
                true,
                None::<&str>,
            )?;

            let separator =
                PredefinedMenuItem::separator(app)?;

            let exit_item = MenuItem::with_id(
                app,
                "exit",
                "Exit WeatherSense",
                true,
                None::<&str>,
            )?;

            let menu = Menu::with_items(
                app,
                &[
                    &open_item,
                    &check_item,
                    &settings_item,
                    &separator,
                    &exit_item,
                ],
            )?;

            /*
             * ============================
             * TRAY ICON
             * ============================
             */

            TrayIconBuilder::with_id("main-tray")
                .icon(
                    app.default_window_icon()
                        .unwrap()
                        .clone(),
                )
                .menu(&menu)
                .tooltip("WeatherSense")
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    match event.id.as_ref() {
                        /*
                         * Open WeatherSense
                         */
                        "open" => {
                            if let Some(window) =
                                app.get_webview_window("main")
                            {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }

                        /*
                         * Check Now
                         */
                        "check" => {
                            let _ = app.emit(
                                "tray-check-now",
                                (),
                            );
                        }

                        /*
                         * Settings
                         */
                        "settings" => {
                            let _ = app.emit(
                                "tray-open-settings",
                                (),
                            );
                        }

                        /*
                         * Exit WeatherSense
                         */
                        "exit" => {
                            app.exit(0);
                        }

                        _ => {}
                    }
                })
                .on_tray_icon_event(
                    |tray, event| {
                        /*
                         * Left-clicking the tray icon
                         * opens the WeatherSense window.
                         */
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state:
                                MouseButtonState::Up,
                            ..
                        } = event
                        {
                            let app =
                                tray.app_handle();

                            if let Some(window) =
                                app.get_webview_window("main")
                            {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    },
                )
                .build(app)?;

            /*
             * ============================
             * BACKGROUND MONITORING SCHEDULER
             * ============================
             */

            let app_handle =
                app.handle().clone();

            let mut scheduler_rx =
                scheduler_rx.clone();

            tauri::async_runtime::spawn(
                async move {
                    println!(
                        "WeatherSense background scheduler started"
                    );

                    loop {
                        /*
                         * Read the latest scheduler settings.
                         */
                        let config =
                            scheduler_rx.borrow().clone();

                        /*
                         * If automatic monitoring is disabled,
                         * wait until Settings changes.
                         *
                         * This is better than polling every few
                         * seconds because the scheduler reacts
                         * immediately to a Settings change.
                         */
                        if !config.monitoring_enabled {
                            println!(
                                "WeatherSense background monitoring disabled"
                            );

                            if scheduler_rx
                                .changed()
                                .await
                                .is_err()
                            {
                                println!(
                                    "WeatherSense scheduler channel closed"
                                );

                                break;
                            }

                            println!(
                                "WeatherSense scheduler settings changed"
                            );

                            continue;
                        }

                        println!(
                            "WeatherSense scheduler waiting {} minutes",
                            config.interval_minutes
                        );

                        /*
                         * Create the countdown using the
                         * current interval.
                         */
                        let duration =
                            Duration::from_secs(
                                config.interval_minutes
                                    * 60,
                            );

                        let sleep =
                            tokio::time::sleep(duration);

                        tokio::pin!(sleep);

                        /*
                         * Wait for either:
                         *
                         * 1. Countdown to finish
                         * 2. Settings to change
                         *
                         * If Settings changes, the countdown
                         * is immediately restarted using the
                         * new interval.
                         */
                        tokio::select! {
                            /*
                             * Countdown finished.
                             */
                            _ = &mut sleep => {
                                let latest_config =
                                    scheduler_rx
                                        .borrow()
                                        .clone();

                                /*
                                 * Only emit the weather check
                                 * if the settings haven't changed
                                 * while the timer was running.
                                 */
                                if latest_config.monitoring_enabled
                                    && latest_config.interval_minutes
                                        == config.interval_minutes
                                {
                                    println!(
                                        "WeatherSense background scheduler tick"
                                    );

                                    let _ =
                                        app_handle.emit(
                                            "background-weather-check",
                                            (),
                                        );
                                }
                            }

                            /*
                             * Settings changed.
                             */
                            changed =
                                scheduler_rx.changed() => {
                                if changed.is_err() {
                                    println!(
                                        "WeatherSense scheduler channel closed"
                                    );

                                    break;
                                }

                                println!(
                                    "WeatherSense scheduler settings changed; restarting countdown"
                                );
                            }
                        }
                    }

                    println!(
                        "WeatherSense background scheduler stopped"
                    );
                },
            );

            Ok(())
        })
        .on_window_event(
            |window, event| {
                /*
                 * Closing the window hides WeatherSense
                 * instead of terminating the application.
                 *
                 * The app continues running in the system tray.
                 */
                if let WindowEvent::CloseRequested {
                    api,
                    ..
                } = event
                {
                    api.prevent_close();

                    let _ = window.hide();
                }
            },
        )
        .invoke_handler(
            tauri::generate_handler![
                update_scheduler
            ],
        )
        .run(
            tauri::generate_context!()
        )
        .expect(
            "error while running Tauri application"
        );
}