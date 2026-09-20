/** Tool 描述符：执行确定动作，不拥有临床主权。 */
export interface RuntimeToolDescriptor {
  id: string;
  description: string;
  risk?: 'low' | 'medium' | 'high';
  /** H14：该工具是否直接面向治疗知识（formula / treatment-form）。Core 不做业务判断。 */
  treatmentSpecific?: boolean;
}
