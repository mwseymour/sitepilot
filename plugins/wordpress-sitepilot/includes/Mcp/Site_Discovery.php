<?php
/**
 * Collects read-only discovery data for the desktop app (no secrets).
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

namespace SitePilot\Mcp;

/**
 * Builds a structured discovery payload for `sitepilot/site-discovery`.
 */
final class Site_Discovery {

	/**
	 * @return array<string, mixed>
	 */
	public static function collect(): array {
		$post_types = array();
		foreach ( get_post_types( array( 'public' => true ), 'objects' ) as $slug => $obj ) {
			$post_types[ $slug ] = array(
				'label'  => $obj->label,
				'public' => (bool) $obj->public,
			);
		}

		$taxonomies = array();
		foreach ( get_taxonomies( array( 'public' => true ), 'objects' ) as $slug => $obj ) {
			$taxonomies[ $slug ] = array(
				'label' => $obj->label,
			);
		}

		$menus = array();
		foreach ( wp_get_nav_menus() as $menu ) {
			$menus[] = array(
				'id'   => (int) $menu->term_id,
				'name' => $menu->name,
				'slug' => $menu->slug,
			);
		}

		$theme = wp_get_theme();
		$active = array_values( (array) get_option( 'active_plugins', array() ) );

		$warnings = array();
		if ( version_compare( (string) PHP_VERSION, '8.1.0', '<' ) ) {
			$warnings[] = 'PHP version is below 8.1; SitePilot recommends PHP 8.1+.';
		}

		return array(
			'wordpress' => array(
				'version' => get_bloginfo( 'version' ),
				'language' => get_bloginfo( 'language' ),
				'timezone' => wp_timezone_string(),
			),
			'site'      => array(
				'name'     => get_bloginfo( 'name' ),
				'tagline'  => get_bloginfo( 'description' ),
				'home_url' => home_url( '/' ),
			),
			'theme'     => array(
				'name'    => $theme->get( 'Name' ),
				'version' => $theme->get( 'Version' ),
				'slug'    => $theme->get_stylesheet(),
			),
			'post_types' => $post_types,
			'taxonomies' => $taxonomies,
			'nav_menus'  => $menus,
			'third_party_blocks' => self::collect_third_party_blocks(),
			'active_plugins' => $active,
			'seo'        => self::detect_seo_plugins(),
			'warnings'   => $warnings,
		);
	}

	/**
	 * @return array<int, array<string, string>>
	 */
	private static function collect_third_party_blocks(): array {
		$blocks = array();

		foreach ( \WP_Block_Type_Registry::get_instance()->get_all_registered() as $name => $block_type ) {
			if ( ! is_string( $name ) || str_starts_with( $name, 'core/' ) ) {
				continue;
			}

			$entry = array(
				'name' => $name,
			);

			if ( isset( $block_type->title ) && is_string( $block_type->title ) && '' !== $block_type->title ) {
				$entry['title'] = $block_type->title;
			}

			if ( isset( $block_type->description ) && is_string( $block_type->description ) && '' !== $block_type->description ) {
				$entry['description'] = $block_type->description;
			}

			if ( isset( $block_type->category ) && is_string( $block_type->category ) && '' !== $block_type->category ) {
				$entry['category'] = $block_type->category;
			}

			$attributes = self::collect_acf_block_attribute_options( $name );
			if ( ! empty( $attributes ) ) {
				$entry['attributes'] = $attributes;
			}

			$blocks[] = $entry;
		}

		usort(
			$blocks,
			static function ( array $left, array $right ): int {
				return strcmp( $left['name'], $right['name'] );
			}
		);

		return $blocks;
	}

	/**
	 * @return array<int, array<string, mixed>>
	 */
	private static function collect_acf_block_attribute_options( string $block_name ): array {
		if ( ! str_starts_with( $block_name, 'acf/' ) || ! function_exists( 'acf_get_field_groups' ) || ! function_exists( 'acf_get_fields' ) ) {
			return array();
		}

		$attributes = array();
		$groups     = acf_get_field_groups();
		if ( ! is_array( $groups ) ) {
			return array();
		}

		foreach ( $groups as $group ) {
			if ( ! is_array( $group ) || ! self::acf_field_group_targets_block( $group, $block_name ) ) {
				continue;
			}

			$fields = acf_get_fields( $group );
			if ( ! is_array( $fields ) ) {
				continue;
			}

			foreach ( self::flatten_acf_fields( $fields ) as $field ) {
				$attribute = self::acf_field_attribute_definition( $field );
				if ( null !== $attribute ) {
					$attributes[] = $attribute;
				}
			}
		}

		return $attributes;
	}

	/**
	 * @param array<string, mixed> $group ACF field group.
	 */
	private static function acf_field_group_targets_block( array $group, string $block_name ): bool {
		$locations = isset( $group['location'] ) && is_array( $group['location'] ) ? $group['location'] : array();
		foreach ( $locations as $rules ) {
			if ( ! is_array( $rules ) ) {
				continue;
			}
			foreach ( $rules as $rule ) {
				if ( ! is_array( $rule ) ) {
					continue;
				}
				if ( ( $rule['param'] ?? null ) !== 'block' ) {
					continue;
				}
				$value = isset( $rule['value'] ) && is_string( $rule['value'] ) ? $rule['value'] : '';
				if ( $value === $block_name || $value === 'acf/' . $block_name || $value === 'core/' . $block_name ) {
					return true;
				}
			}
		}

		return false;
	}

	/**
	 * @param array<int, mixed> $fields ACF fields.
	 * @return array<int, array<string, mixed>>
	 */
	private static function flatten_acf_fields( array $fields ): array {
		$flat = array();
		foreach ( $fields as $field ) {
			if ( ! is_array( $field ) ) {
				continue;
			}
			$flat[] = $field;
			foreach ( array( 'sub_fields', 'layouts' ) as $child_key ) {
				if ( ! isset( $field[ $child_key ] ) || ! is_array( $field[ $child_key ] ) ) {
					continue;
				}
				foreach ( $field[ $child_key ] as $child ) {
					if ( isset( $child['sub_fields'] ) && is_array( $child['sub_fields'] ) ) {
						$flat = array_merge( $flat, self::flatten_acf_fields( $child['sub_fields'] ) );
					}
				}
			}
		}
		return $flat;
	}

	/**
	 * @param array<string, mixed> $field ACF field.
	 * @return array<string, mixed>|null
	 */
	private static function acf_field_attribute_definition( array $field ): ?array {
		$name = isset( $field['name'] ) && is_string( $field['name'] ) ? $field['name'] : '';
		if ( '' === $name ) {
			return null;
		}

		$type = isset( $field['type'] ) && is_string( $field['type'] ) ? $field['type'] : '';
		if ( ! in_array( $type, array( 'select', 'radio', 'button_group', 'checkbox', 'true_false' ), true ) ) {
			return null;
		}

		$definition = array(
			'path'      => 'data.' . $name,
			'fieldName' => $name,
			'control'   => $type,
		);

		if ( isset( $field['key'] ) && is_string( $field['key'] ) && '' !== $field['key'] ) {
			$definition['fieldKey'] = $field['key'];
		}
		if ( isset( $field['label'] ) && is_string( $field['label'] ) && '' !== $field['label'] ) {
			$definition['label'] = $field['label'];
		}
		if ( isset( $field['choices'] ) && is_array( $field['choices'] ) ) {
			$options = array();
			foreach ( $field['choices'] as $value => $label ) {
				if ( is_scalar( $value ) && is_scalar( $label ) ) {
					$options[] = array(
						'value' => (string) $value,
						'label' => (string) $label,
					);
				}
			}
			if ( ! empty( $options ) ) {
				$definition['options'] = $options;
			}
		}

		return $definition;
	}

	/**
	 * @return array<string, mixed>
	 */
	private static function detect_seo_plugins(): array {
		$active = (array) get_option( 'active_plugins', array() );
		$found  = array();
		foreach ( $active as $file ) {
			if ( ! is_string( $file ) ) {
				continue;
			}
			if ( str_contains( $file, 'wordpress-seo' ) ) {
				$found['yoast_seo'] = true;
			}
			if ( str_contains( $file, 'seo-by-rank-math' ) ) {
				$found['rank_math'] = true;
			}
			if ( str_contains( $file, 'all-in-one-seo-pack' ) ) {
				$found['aioseo'] = true;
			}
		}
		return $found;
	}
}
